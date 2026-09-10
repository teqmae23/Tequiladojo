// firebase-functions v6ではトップレベルがv2 APIのため、v1 APIを明示的に読み込む
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');
admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

// ── Stripe（決済） ────────────────────────────────────────────────
// stripeWebhook / createStripeCustomer 用のシークレット。値はGCP側で設定済み。
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
// StripeのPrice ID → 会員グレード対応
const PRICE_GRADE_MAP = {
  'price_1TUegc1PL3PJaVpo3Hc1vuH6': 1,
  'price_1TUei41PL3PJaVpoiiQn3Or0': 2,
};

// ── roleをCustom Claimsに設定 ──────────────────────────────────
// Firestoreのmembers/{memberId}.roleをCustom Claimsに同期する
exports.setCustomClaims = functions.region('asia-northeast1')
  .firestore.document('members/{memberId}')
  .onWrite(async (change, context) => {
    const data = change.after.exists ? change.after.data() : null;
    if (!data) return null;

    const role = data.role || null;
    const authUid = data.authUid || null;
    if (!authUid) return null;

    try {
      const currentUser = await auth.getUser(authUid);
      const currentClaims = currentUser.customClaims || {};
      if (currentClaims.role === role) return null; // 変更なし

      await auth.setCustomUserClaims(authUid, { role: role });
      console.log(`Set role=${role} for uid=${authUid} (memberId=${context.params.memberId})`);
    } catch (e) {
      console.error('setCustomClaims error:', e);
    }
    return null;
  });

// ── members.email 変更を memberIndex に同期（会員IDログインの解決用） ──
// memberIndexはスタッフ限定書き込みのため、会員本人のメール変更確定時は
// このトリガーがサーバー権限で反映する
exports.syncMemberIndex = functions.region('asia-northeast1')
  .firestore.document('members/{memberId}')
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return null;
    const before = change.before.exists ? change.before.data() : {};
    const newEmail = after.email || '';
    if (!newEmail || newEmail === (before.email || '')) return null;
    try {
      await db.collection('memberIndex').doc(context.params.memberId)
        .set({ email: newEmail }, { merge: true });
    } catch (e) {
      console.error('syncMemberIndex error:', e);
    }
    return null;
  });

// ── 既存会員のClaims一括設定（初回セットアップ用） ─────────────
exports.syncAllRoles = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    // ownerのみ実行可能
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const snap = await db.collection('members').where('role', '!=', null).get();
    const results = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.authUid || !d.role) continue;
      try {
        await auth.setCustomUserClaims(d.authUid, { role: d.role });
        results.push({ memberId: doc.id, authUid: d.authUid, role: d.role, ok: true });
      } catch (e) {
        results.push({ memberId: doc.id, authUid: d.authUid, error: e.message });
      }
    }
    return { results };
  });

// ── スタッフ管理（home.htmlから呼び出し） ─────────────────────
exports.setUserRole = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const { uid, role } = data;
    if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uidが必要です');

    if (role === null || role === undefined) {
      await auth.setCustomUserClaims(uid, {});
    } else {
      await auth.setCustomUserClaims(uid, { role });
    }
    // Firestoreのmembersも更新
    const snap = await db.collection('members').where('authUid', '==', uid).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({ role: role || null });
    }
    return { ok: true };
  });

exports.getStaffList = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const listResult = await auth.listUsers(1000);
    const staff = listResult.users
      .filter(u => u.customClaims && u.customClaims.role)
      .map(u => ({
        uid: u.uid,
        email: u.email,
        role: u.customClaims.role
      }));
    return { staff };
  });

// ── 共通: スタッフ/オーナー権限チェック ─────────────────────────
// claims → staffRoles/{uid} → members(authUid).role の順で確認する
async function resolveStaffRole(context) {
  if (!context.auth) return null;
  const claimRole = context.auth.token.role;
  if (claimRole === 'owner' || claimRole === 'staff') return claimRole;
  try {
    const sr = await db.collection('staffRoles').doc(context.auth.uid).get();
    if (sr.exists && ['owner', 'staff'].includes(sr.data().role)) return sr.data().role;
  } catch (e) { /* noop */ }
  try {
    const ms = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
    if (!ms.empty && ['owner', 'staff'].includes(ms.docs[0].data().role)) return ms.docs[0].data().role;
  } catch (e) { /* noop */ }
  return null;
}

async function assertStaff(context) {
  const role = await resolveStaffRole(context);
  if (!role) throw new functions.https.HttpsError('permission-denied', 'スタッフ権限が必要です');
  return role;
}

// ── 会員本人の来店・注文・ブラインド結果を返す ─────────────────
// visits/orders はセキュリティルールでスタッフ限定読み取りのため、
// 会員向けページ（mypage/tastinglog/member_map）はここ経由で本人分のみ取得する
// Firestore の Timestamp / GeoPoint / DocumentReference などは callable の応答JSONに
// そのまま含めると、ハンドラの try/catch の「外側」（フレームワークのシリアライズ処理）で
// 失敗し、捕捉不能な INTERNAL になる。返却前に必ずプレーンなJSONへ再帰変換する。
function jsonSafe(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  const FS = admin.firestore;
  if (FS && FS.Timestamp && v instanceof FS.Timestamp) return v.toMillis();
  if (typeof v.toDate === 'function' && typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (FS && FS.GeoPoint && v instanceof FS.GeoPoint) return { lat: v.latitude, lng: v.longitude };
  if (FS && FS.DocumentReference && v instanceof FS.DocumentReference) return v.path;
  if (Array.isArray(v)) return v.map(jsonSafe);
  const out = {};
  Object.keys(v).forEach((k) => { const s = jsonSafe(v[k]); if (s !== undefined) out[k] = s; });
  return out;
}

exports.getMemberActivity = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
   try {
    if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    // 対象会員の解決（previewMemberId はスタッフのみ指定可能）
    let memberId = null;
    let memberData = null;
    const preview = data && data.previewMemberId ? String(data.previewMemberId) : null;
    if (preview) {
      await assertStaff(context);
      const mDoc = await db.collection('members').doc(preview).get();
      if (!mDoc.exists) throw new functions.https.HttpsError('not-found', '会員が見つかりません');
      memberId = mDoc.id; memberData = mDoc.data();
    } else {
      const snap = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
      if (snap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
      memberId = snap.docs[0].id; memberData = snap.docs[0].data();
    }

    // visits: realId（docID）と旧displayIdの両方で紐づく可能性がある
    const idSet = new Set([memberId]);
    if (memberData.memberId) idSet.add(String(memberData.memberId));
    if (memberData.displayId) idSet.add(String(memberData.displayId));

    // 集計は段階的に行い、途中で失敗しても（例: 特定コレクションのクエリ例外）
    // 500(INTERNAL)にせず、取得できた分だけ返す。少なくとも来場履歴(visits)は表示できる。
    let visits = []; let orders = []; let blindResults = []; let batchOrders = [];
    let visitMemberMap = {}; let memberNames = {};
    try {
      const visitsMap = {};
      for (const mid of idSet) {
        const vs = await db.collection('visits').where('memberId', '==', mid).get();
        vs.forEach((d) => { visitsMap[d.id] = Object.assign({ id: d.id }, d.data()); });
      }
      visits = Object.values(visitsMap);
      const visitIds = visits.map((v) => v.id);

      // orders: visitKey（新）/visitId（旧）両対応
      const ordersMap = {};
      for (let i = 0; i < visitIds.length; i += 30) {
        const chunk = visitIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const s1 = await db.collection('orders').where('visitKey', 'in', chunk).get();
        s1.forEach((d) => { ordersMap[d.id] = Object.assign({ id: d.id }, d.data()); });
        const s2 = await db.collection('orders').where('visitId', 'in', chunk).get();
        s2.forEach((d) => { ordersMap[d.id] = Object.assign({ id: d.id }, d.data()); });
      }
      orders = Object.values(ordersMap);

      // blindResults: 自分の注文が属するバッチ全員分（正解表示・同席者表示に必要）
      const batchIds = [...new Set(orders.map((o) => o.batchId).filter(Boolean))];
      for (let i = 0; i < batchIds.length; i += 30) {
        const chunk = batchIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const s = await db.collection('blindResults').where('batchId', 'in', chunk).get();
        s.forEach((d) => {
          const r = Object.assign({ id: d.id }, d.data());
          if (r.answeredAt && r.answeredAt.toMillis) r.answeredAt = r.answeredAt.toMillis();
          blindResults.push(r);
        });
      }

      // 同席情報: 同一バッチ内の他会員の注文（visitKey/batchIdのみ返す）
      const myVkSet = new Set(visitIds);
      for (let i = 0; i < batchIds.length; i += 30) {
        const chunk = batchIds.slice(i, i + 30);
        if (!chunk.length) continue;
        const s = await db.collection('orders').where('batchId', 'in', chunk).get();
        s.forEach((d) => {
          const o = d.data();
          // 奢りの支払注文(isGiftPayer)は「支払のみ・本人は飲んでいない」ため同席者に数えない。
          // 本人も飲む場合は別途 isGiftSelf の0円注文があり、そちらが同席者として拾われる。
          if (o.isGiftPayer) return;
          const vk = o.visitKey || o.visitId;
          if (vk && !myVkSet.has(vk)) batchOrders.push({ visitKey: vk, batchId: o.batchId });
        });
      }

      // 他visitKey → memberId、memberId → ニックネーム
      const otherVks = [...new Set([
        ...batchOrders.map((b) => b.visitKey),
        ...blindResults.map((r) => r.visitKey || r.visitId).filter((vk) => vk && !myVkSet.has(vk)),
      ])].filter((vk) => vk != null && vk !== '');
      for (let i = 0; i < otherVks.length; i += 100) {
        const refs = otherVks.slice(i, i + 100).map((vk) => db.collection('visits').doc(String(vk)));
        if (!refs.length) continue;
        const snaps = await db.getAll(...refs);
        snaps.forEach((s) => { if (s.exists && s.data().memberId) visitMemberMap[s.id] = s.data().memberId; });
      }
      const otherMids = [...new Set([
        ...Object.values(visitMemberMap),
        ...blindResults.map((r) => r.customerId).filter(Boolean),
      ])].filter((m) => m != null && m !== '' && m !== memberId);
      for (let i = 0; i < otherMids.length; i += 100) {
        const refs = otherMids.slice(i, i + 100).map((m) => db.collection('members').doc(String(m)));
        if (!refs.length) continue;
        const snaps = await db.getAll(...refs);
        snaps.forEach((s) => {
          if (s.exists) { const md = s.data(); memberNames[s.id] = md.nickname || md.name || s.id; }
        });
      }
    } catch (e) {
      // 例外の詳細はサーバーログに残し、画面には部分結果を返す（INTERNALを表示しない）
      console.error('[getMemberActivity] aggregation failed for member ' + memberId + ':', (e && e.stack) || e);
    }

    const _ret = jsonSafe({ memberId, visits, orders, blindResults, batchOrders, visitMemberMap, memberNames });
    // callable のフレームワーク側エンコーダが特定のFirestore型で失敗し、ハンドラの
    // try/catch の外側で捕捉不能な 500(INTERNAL) になる問題を回避するため、応答は
    // JSON文字列として返す（文字列は必ずエンコードできる）。クライアントで JSON.parse する。
    let _json;
    try { _json = JSON.stringify(_ret); } catch (se) {
      throw new functions.https.HttpsError('failed-precondition', 'MA-serialize: ' + ((se && se.message) || se));
    }
    return { __json: _json };
   } catch (e) {
     if (e instanceof functions.https.HttpsError) throw e;
     console.error('[getMemberActivity] error:', (e && e.stack) || e);
     // internal はメッセージがクライアントで INTERNAL に潰れるため、原因表示用に別コードを使う
     throw new functions.https.HttpsError('failed-precondition', 'MA-error: ' + ((e && e.message) || e));
   }
  });

// ── 会員登録（新規・引継コード共通） ─────────────────────────────
// カウンター採番・アカウント作成・会員ドキュメント作成をサーバー側で行う
function allocDisplayId() {
  const year = String(new Date().getFullYear()).slice(2);
  const ref = db.collection('settings').doc('memberCounter');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const d = doc.exists ? doc.data() : {};
    const seqMap = d.memberSeq || {};
    const next = (seqMap[year] || 0) + 1;
    seqMap[year] = next;
    tx.set(ref, { memberSeq: seqMap }, { merge: true });
    return year + String(next).padStart(4, '0');
  });
}
function allocRealId() {
  const ref = db.collection('settings').doc('memberCounter');
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const d = doc.exists ? doc.data() : {};
    const realSeq = d.realSeq || 101;
    tx.set(ref, { realSeq: realSeq + 1 }, { merge: true });
    return String(realSeq).padStart(6, '0');
  });
}
function regError(e) {
  if (e && e.code === 'auth/email-already-exists') {
    return new functions.https.HttpsError('already-exists', 'このメールアドレスは既に登録されています');
  }
  if (e && e.code === 'auth/invalid-email') {
    return new functions.https.HttpsError('invalid-argument', 'メールアドレスの形式が正しくありません');
  }
  if (e && e.code === 'auth/invalid-password') {
    return new functions.https.HttpsError('invalid-argument', 'パスワードは8文字以上にしてください');
  }
  return new functions.https.HttpsError('internal', (e && e.message) || '登録に失敗しました');
}
function writeServerJournal(op, col, docId, before, after, page) {
  return db.collection('journals').add({
    op, col, docId: String(docId),
    before: before || null, after: after || null,
    by: 'functions:' + page, at: admin.firestore.FieldValue.serverTimestamp(), page,
  }).catch(() => {});
}

// ── 会員本人のデポジット履歴を返す（depositData はスタッフ限定読み取りのため） ──
exports.getMyDepositHistory = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    let memberId = null;
    let memberData = null;
    const preview = data && data.previewMemberId ? String(data.previewMemberId) : null;
    if (preview) {
      await assertStaff(context);
      const mDoc = await db.collection('members').doc(preview).get();
      if (!mDoc.exists) throw new functions.https.HttpsError('not-found', '会員が見つかりません');
      memberId = mDoc.id; memberData = mDoc.data();
    } else {
      const snap = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
      if (snap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
      memberId = snap.docs[0].id; memberData = snap.docs[0].data();
    }
    const ds = await db.collection('depositData').where('memberId', '==', memberId).get();
    const items = ds.docs.map((d) => {
      const x = d.data();
      return {
        date: x.date || '', time: x.time || '',
        amount: x.amount || 0,
        balanceAfter: x.balanceAfter != null ? x.balanceAfter : null,
        kind: x.kind || '', source: x.source || '',
      };
    });
    items.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    const enabled = memberData.depositEnabled === 1 || memberData.depositEnabled === '1' || memberData.depositEnabled === true;
    return { enabled, balance: Number(memberData.depositBalance || 0), items };
  });

exports.registerMember = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const nickname = ((data && data.nickname) || '').trim();
    const email = ((data && data.email) || '').trim();
    const password = (data && data.password) || '';
    const transferCode = ((data && data.transferCode) || '').trim().toUpperCase();
    const wantStatus = (data && data.status) === 'active' ? 'active' : 'pending';
    if (!password || password.length < 8) {
      throw new functions.https.HttpsError('invalid-argument', 'パスワードは8文字以上にしてください');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new functions.https.HttpsError('invalid-argument', 'メールアドレスの形式が正しくありません');
    }
    const today = new Date().toISOString().slice(0, 10);

    if (transferCode) {
      // ── 引継コードによる本登録 ──
      if (!email) throw new functions.https.HttpsError('invalid-argument', 'メールアドレスを入力してください');
      const codeRef = db.collection('tempRegistrations').doc(transferCode);
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) throw new functions.https.HttpsError('not-found', '引継コードが見つかりません');
      const cd = codeSnap.data();
      if (cd.used) throw new functions.https.HttpsError('failed-precondition', '引継コードは既に使用済みです');
      if (cd.expiresAt && new Date(cd.expiresAt) < new Date()) {
        throw new functions.https.HttpsError('failed-precondition', '引継コードの有効期限が切れています');
      }
      const realId = String(cd.tempId || '');
      const memRef = db.collection('members').doc(realId);
      const memSnap = await memRef.get();
      if (!memSnap.exists) throw new functions.https.HttpsError('not-found', '引継対象の会員が見つかりません');
      const memBefore = memSnap.data();
      if (memBefore.authUid) {
        throw new functions.https.HttpsError('already-exists', 'この会員は既にアカウント連携済みです');
      }
      let user;
      try { user = await auth.createUser({ email, password }); } catch (e) { throw regError(e); }
      try {
        const displayId = await allocDisplayId();
        const upd = {
          authUid: user.uid, email, nickname: nickname || cd.nickname || memBefore.nickname || null,
          status: 'pending', isGuest: false, registeredAt: today,
          displayId, memberId: displayId,
        };
        const batch = db.batch();
        batch.update(memRef, upd);
        batch.set(db.collection('memberIndex').doc(realId), { email });
        batch.update(codeRef, { used: true });
        await batch.commit();
        await writeServerJournal('update', 'members', realId, memBefore, Object.assign({}, memBefore, upd), 'registerMember');
        return { memberId: displayId, realId, authEmail: email, transfer: true };
      } catch (e) {
        await auth.deleteUser(user.uid).catch(() => {});
        throw new functions.https.HttpsError('internal', '登録処理に失敗しました: ' + e.message);
      }
    }

    // ── 新規登録 ──
    if (!nickname) throw new functions.https.HttpsError('invalid-argument', 'ニックネームを入力してください');
    const realId = await allocRealId();
    const displayId = await allocDisplayId();
    const authEmail = email || (displayId + '@tequiladojo.member');
    let user;
    try { user = await auth.createUser({ email: authEmail, password }); } catch (e) { throw regError(e); }
    try {
      const memberDoc = {
        authUid: user.uid, realId, displayId, memberId: displayId,
        email: email || null,
        status: email ? wantStatus : 'active',
        nickname, registeredAt: today,
        visitCount: 0, totalAmount: 0, totalTequila: 0,
      };
      const batch = db.batch();
      batch.set(db.collection('members').doc(realId), memberDoc);
      batch.set(db.collection('memberIndex').doc(realId), { email: authEmail });
      await batch.commit();
      await writeServerJournal('create', 'members', realId, null, memberDoc, 'registerMember');
      return { memberId: displayId, realId, authEmail, transfer: false };
    } catch (e) {
      await auth.deleteUser(user.uid).catch(() => {});
      throw new functions.https.HttpsError('internal', '登録処理に失敗しました: ' + e.message);
    }
  });

// ── 会員IDログイン: ID→メール解決とパスワード検証をサーバー側で行う ──
// memberIndexを公開読み取りにするとID総当たりで全会員のメールが列挙できてしまうため、
// メールアドレスを端末に返さずにログインを成立させる。
// 検証はIdentity Toolkitに委譲し、成功時のみカスタムトークンを返す。
exports.loginWithMemberId = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const memberId = ((data && data.memberId) || '').trim();
    const password = (data && data.password) || '';
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(memberId) || !password) {
      throw new functions.https.HttpsError('invalid-argument', 'IDとパスワードを入力してください');
    }
    // ID→メール解決
    // 入力IDは会員に表示される「表示ID(displayId)」。ただし members ドキュメントの
    // IDは内部ID(realId)であることが多く、memberIndex も realId でキーされ、さらに
    // 登録経路によっては members.email が実際のAuthメールと一致しない。そこで、
    //  1) 入力IDから会員ドキュメントを特定（docId一致→displayId→memberId、文字列/数値両対応）
    //  2) 会員の authUid から Auth レコードの「実メール」を取得（最も確実）
    //  3) 取れなければ members.email／仮想メール／memberIndex にフォールバック
    let memberDoc = null;
    try {
      const direct = await db.collection('members').doc(memberId).get();
      if (direct.exists) {
        memberDoc = direct;
      } else {
        const tryFields = ['displayId', 'memberId'];
        const vals = [memberId];
        if (/^\d+$/.test(memberId)) vals.push(Number(memberId)); // 数値保存されているケース
        for (let fi = 0; fi < tryFields.length && !memberDoc; fi++) {
          for (let vi = 0; vi < vals.length && !memberDoc; vi++) {
            const snap = await db.collection('members').where(tryFields[fi], '==', vals[vi]).limit(1).get();
            if (!snap.empty) memberDoc = snap.docs[0];
          }
        }
      }
    } catch (e) { /* noop */ }

    // 認証を試すメール候補を優先順で組み立てる（登録経路によるメール不整合に強くする）。
    // すべてサーバー側で試行し、最初に成功したもので確定する。失敗時は同一メッセージ（列挙対策）。
    const candidates = [];
    const addCand = (e) => { if (e && candidates.indexOf(e) === -1) candidates.push(e); };
    if (memberDoc) {
      const m = memberDoc.data();
      if (m.authUid) {
        try { const u = await auth.getUser(m.authUid); if (u && u.email) addCand(u.email); } catch (e) { /* noop */ }
      }
      addCand(m.email);
      addCand((m.displayId || '') && (m.displayId + '@tequiladojo.member'));
      addCand((m.memberId || '') && (m.memberId + '@tequiladojo.member'));
      addCand(memberDoc.id + '@tequiladojo.member');
    }
    try {
      const idx = await db.collection('memberIndex').doc(memberId).get();
      if (idx.exists && idx.data().email) addCand(idx.data().email);
    } catch (e) { /* noop */ }
    addCand(memberId + '@tequiladojo.member');

    // パスワード検証（Web APIキーは公開情報のため秘匿対象ではない）
    const API_KEY = 'AIzaSyD6a3i-N1RyXyAfXmztPQrYtx4x62YGth0';
    let localId = null;
    let workingEmail = null;
    for (let i = 0; i < candidates.length && !localId; i++) {
      try {
        const resp = await fetch(
          'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: candidates[i], password, returnSecureToken: true }),
          }
        );
        const body = await resp.json().catch(() => ({}));
        if (resp.ok && body.localId) { localId = body.localId; workingEmail = candidates[i]; }
      } catch (e) { /* 次の候補へ */ }
    }
    if (!localId) {
      // 存在しないID・誤パスワードを区別せず同一メッセージ（列挙対策）
      throw new functions.https.HttpsError('unauthenticated', 'IDまたはパスワードが正しくありません');
    }
    // カスタムトークン発行にはサービスアカウントの署名権限
    // （iam.serviceAccounts.signBlob ＝「サービス アカウント トークン作成者」ロール）が必要で、
    // 付与されていない環境では createCustomToken が例外を投げ 500 になる。パスワードは上で
    // 検証済みなので、その場合は確定したメールアドレスを返し、クライアント側で
    // signInWithEmailAndPassword によりログインさせる（パスワード成功時のみ返すため列挙対策は保たれる）。
    try {
      const token = await auth.createCustomToken(localId);
      return { token };
    } catch (e) {
      console.warn('createCustomToken unavailable; returning email for client sign-in:', (e && e.message) || e);
      return { email: workingEmail };
    }
  });

// ── 店頭ステータス（Firestore + RTDB）をスタッフ権限で更新 ──────
// RTDB側は「.write: false」にしてこの関数経由のみとする
// RTDBはデプロイ後に作成されてもよいようURLを明示し、失敗しても
// Firestore更新が成功していればエラーにしない（index.htmlはgetStoreStatusにフォールバックする）
const RTDB_URL = 'https://tequiladojo-default-rtdb.firebaseio.com';
exports.setStoreStatus = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const status = (data && data.status) || 'closed';
    if (!['open', 'closed', 'break'].includes(status)) {
      throw new functions.https.HttpsError('invalid-argument', 'statusはopen/closed/breakのいずれかです');
    }
    const extraIn = (data && data.extra) || {};
    const extra = {};
    ['layoutId', 'sessionDate', 'breakResumeTime'].forEach((k) => {
      if (extraIn[k] !== undefined && extraIn[k] !== null) extra[k] = extraIn[k];
    });
    const fsData = Object.assign({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, extra);
    const prev = await db.collection('storeStatus').doc('current').get();
    await db.collection('storeStatus').doc('current').set(fsData);
    let rtdbOk = true;
    try {
      await admin.app().database(RTDB_URL).ref('storeStatus')
        .set(Object.assign({ status, updatedAt: Date.now() }, extra));
    } catch (e) {
      rtdbOk = false;
      console.warn('RTDB write failed (RTDB未作成の可能性。Firestore更新は成功):', e.message);
    }
    await writeServerJournal('update', 'storeStatus', 'current',
      prev.exists ? prev.data() : null, Object.assign({ status }, extra), 'setStoreStatus');
    return { ok: true, rtdb: rtdbOk };
  });

// ── 公開: 店頭ステータス＋来店数を返す（index.html用・認証不要） ──
// ── TOPページのアクセス記録（同日・同IPで1件。IPはハッシュ化。国も記録） ──
// IP はサーバー側でしか取れないため getStoreStatus に相乗り（data.logTop=true の時のみ）。
async function lookupCountry(ip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('https://ipwho.is/' + encodeURIComponent(ip) + '?fields=success,country,country_code', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.success !== false) return { name: j.country || '', code: j.country_code || '' };
  } catch (e) { /* ignore */ }
  return { name: '', code: '' };
}
async function recordTopAccess(context, page) {
  page = (page === 'member') ? 'member' : 'top'; // 公開TOP(index) / 会員TOP(会員ページ)
  const req = context && context.rawRequest;
  if (!req) { console.warn('[topAccess] no rawRequest'); return; }
  const xff = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-appengine-user-ip'] || req.headers['fastly-client-ip'])) || '';
  let ip = String(xff).split(',')[0].trim();
  if (!ip && req.ip) ip = String(req.ip);
  if (!ip) { console.warn('[topAccess] no ip (xff=' + JSON.stringify(xff) + ')'); return; }
  const crypto = require('crypto');
  const SALT = 'tequiladojo-topaccess-v1'; // 固定ソルト（必要なら将来Secret化）。生IPは保存しない。
  const ipHash = crypto.createHash('sha256').update(SALT + '|' + ip).digest('hex').slice(0, 40);
  const jd = new Date(Date.now() + 9 * 3600 * 1000); // JST
  const p2 = (n) => String(n).padStart(2, '0');
  const dayCompact = '' + jd.getUTCFullYear() + p2(jd.getUTCMonth() + 1) + p2(jd.getUTCDate());
  const dayIso = jd.getUTCFullYear() + '-' + p2(jd.getUTCMonth() + 1) + '-' + p2(jd.getUTCDate());
  const FV = admin.firestore.FieldValue;
  // 公開TOPは従来どおりのdocId（後方互換）。会員TOPはpageを挟んで別集計にする。
  const idSuffix = (page === 'top') ? '' : (page + '_');
  const ref = db.collection('topAccessLogs').doc(dayCompact + '_' + idSuffix + ipHash);
  const snap = await ref.get();
  if (snap.exists) {
    await ref.update({ hits: FV.increment(1), lastAt: FV.serverTimestamp() });
    console.log('[topAccess] hit++ ' + page + ' ' + dayCompact + '_' + ipHash.slice(0, 8));
    return;
  }
  const geo = await lookupCountry(ip);
  await ref.set({
    day: dayIso, ipHash, page,
    country: geo.name || '', countryCode: geo.code || '',
    hits: 1, firstAt: FV.serverTimestamp(), lastAt: FV.serverTimestamp(),
  });
  console.log('[topAccess] new ' + page + ' ' + dayCompact + '_' + ipHash.slice(0, 8) + ' country=' + (geo.name || '?'));
}

exports.getStoreStatus = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    // TOPページからの呼び出し時のみアクセス記録（本来のステータス応答には影響させない）
    const logPage = (data && data.page === 'member') ? 'member' : 'top';
    console.log('[topAccess] getStoreStatus called, logTop=' + !!(data && data.logTop) + ' page=' + logPage);
    const logP = (data && data.logTop)
      ? recordTopAccess(context, logPage).catch((e) => console.error('[topAccess] error:', (e && e.message) || e))
      : Promise.resolve();
    const statusP = (async () => {
      const doc = await db.collection('storeStatus').doc('current').get();
      if (!doc.exists) return { status: 'closed' };
      const sd = doc.data();
      const out = { status: sd.status || 'closed' };
      if (out.status === 'break') {
        out.breakResumeTime = sd.breakResumeTime || null;
        return out;
      }
      if (out.status === 'open') {
        if (sd.sessionDate) {
          out.sessionDate = sd.sessionDate; // 現在の営業セッション日（会員ページの「来場中」判定に使用）
          const vs = await db.collection('visits').where('visitDate', '==', sd.sessionDate).get();
          out.active = vs.docs.filter((d) => !d.data().checkoutTime && !d.data().isStaff).length;
        }
        if (sd.layoutId) {
          const l = await db.collection('layouts').doc(String(sd.layoutId)).get();
          if (l.exists) out.seats = l.data().seats;
        }
      }
      return out;
    })();
    const [out] = await Promise.all([statusP, logP]);
    return out;
  });

// ── オーナーによる会員メールアドレス変更 ──────────────────────────
exports.adminUpdateEmail = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const { memberId, newEmail } = data;
    if (!memberId) throw new functions.https.HttpsError('invalid-argument', 'memberIdが必要です');
    if (!newEmail || !newEmail.includes('@')) throw new functions.https.HttpsError('invalid-argument', '有効なメールアドレスを入力してください');

    const memberDoc = await db.collection('members').doc(memberId).get();
    if (!memberDoc.exists) throw new functions.https.HttpsError('not-found', '会員が見つかりません');
    const memberData = memberDoc.data();
    if (!memberData.authUid) throw new functions.https.HttpsError('failed-precondition', 'Auth連携がありません');

    // メールアドレスの重複確認
    try {
      const existing = await auth.getUserByEmail(newEmail);
      if (existing.uid !== memberData.authUid) {
        throw new functions.https.HttpsError('already-exists', 'そのメールアドレスは既に使用されています');
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
    }

    await auth.updateUser(memberData.authUid, { email: newEmail, emailVerified: true });

    const batch = db.batch();
    batch.update(db.collection('members').doc(memberId), {
      email: newEmail,
      pendingEmail: admin.firestore.FieldValue.delete(),
      status: 'active'
    });
    batch.set(db.collection('memberIndex').doc(memberId), { email: newEmail });
    await batch.commit();

    return { ok: true };
  });

// ── 孤児Auth検出 ──────────────────────────────────────────────────
// membersドキュメントに紐づかない（＝ログインできるのに会員マスタに存在しない）
// Firebase Authアカウントを洗い出す。ハード削除でAuthだけ残ったケース等の調査用。
exports.listOrphanAuthUsers = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    // members の authUid を収集（削除済みも含めて突合する）
    const memSnap = await db.collection('members').get();
    const linkedUids = new Set();
    memSnap.forEach((d) => { const u = d.data().authUid; if (u) linkedUids.add(u); });

    const orphans = [];
    let totalAuth = 0;
    let pageToken;
    do {
      const res = await auth.listUsers(1000, pageToken);
      res.users.forEach((u) => {
        totalAuth++;
        if (!linkedUids.has(u.uid)) {
          orphans.push({
            uid: u.uid,
            email: u.email || null,
            disabled: !!u.disabled,
            creationTime: (u.metadata && u.metadata.creationTime) || null,
            lastSignInTime: (u.metadata && u.metadata.lastSignInTime) || null,
          });
        }
      });
      pageToken = res.pageToken;
    } while (pageToken);

    return { orphans, totalAuth, totalMembers: memSnap.size, linkedCount: linkedUids.size };
  });

// ═══════════════════════════════════════════════════════════════════
// 以下は従来 us-central1 にデプロイされている関数（Stripe決済・旧admin系）。
// リージョン未指定のため us-central1 にデプロイされる（現状維持）。
// ※注意: setUserRole / getStaffList の旧版（staffコレクション使用）は
//   asia-northeast1 版（上部）が現行のため、ここには含めない。
// ═══════════════════════════════════════════════════════════════════

// ── Stripe Webhook（サブスク支払い状態を members に反映） ──
exports.stripeWebhook = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] })
  .https.onRequest(async (req, res) => {
    const stripe = require('stripe')(stripeSecretKey.value());
    const webhookSecret = stripeWebhookSecret.value();
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        webhookSecret
      );
    } catch (err) {
      return res.status(400).send('Webhook Error: ' + err.message);
    }

    const obj = event.data.object;

    if (event.type === 'invoice.payment_succeeded') {
      const cid = obj.customer;
      const line = (obj.lines && obj.lines.data && obj.lines.data[0]) || {};
      // StripeのAPIバージョン差異に耐性を持たせる（旧: line.price / 新: line.pricing.price_details.price）
      let priceId = (line.price && line.price.id)
        || (line.pricing && line.pricing.price_details && line.pricing.price_details.price)
        || (line.plan && line.plan.id) || null;
      // subscription も旧 invoice.subscription / 新 parent.subscription_details.subscription 等に対応
      let subId = obj.subscription
        || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription)
        || (line.parent && line.parent.subscription_item_details && line.parent.subscription_item_details.subscription)
        || null;
      let periodEnd = (line.period && line.period.end) || obj.period_end || null;
      // 請求書(invoice)の形はAPIバージョンで揺れるため、取れない項目はサブスク本体から補完する
      // （サブスクの items.data[0].price.id は版に依らず安定して取得できる）
      if ((!priceId || !periodEnd) && subId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          const it = sub.items && sub.items.data && sub.items.data[0];
          if (!priceId && it && it.price) priceId = it.price.id;
          if (!periodEnd) periodEnd = sub.current_period_end || (it && it.current_period_end) || null;
        } catch (e) { /* ignore */ }
      }
      // plans コレクションから priceId→level を動的解決（無ければ旧マップにフォールバック）
      let grade = null;
      let planId = null;
      try {
        const psnap = await db.collection('plans')
          .where('stripePriceId', '==', priceId).limit(1).get();
        if (!psnap.empty) {
          grade = Number(psnap.docs[0].data().level) || 0;
          planId = psnap.docs[0].id;
        }
      } catch (e) { /* ignore */ }
      if (grade == null) grade = PRICE_GRADE_MAP[priceId];
      if (grade != null) {
        const snap = await db.collection('members')
          .where('stripeCustomerId', '==', cid).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({
            grade: grade,
            subscriptionPlanId: planId,
            stripeSubscriptionId: subId,
            subscriptionStatus: 'active',
            subscriptionPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
            subscriptionPastDueSince: null, // 支払い完了で遅延状態を解消
          });
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const cid = obj.customer;
      const snap = await db.collection('members')
        .where('stripeCustomerId', '==', cid).limit(1).get();
      if (!snap.empty) {
        const upd = { subscriptionStatus: 'past_due' };
        // 支払い遅延の開始時刻を初回のみ記録（1ヶ月経過で「休会中」表示に使う）。
        if (!snap.docs[0].data().subscriptionPastDueSince) {
          upd.subscriptionPastDueSince = admin.firestore.FieldValue.serverTimestamp();
        }
        await snap.docs[0].ref.update(upd);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const cid = obj.customer;
      const snap = await db.collection('members')
        .where('stripeCustomerId', '==', cid).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({
          grade: 0,
          subscriptionPlanId: null,
          stripeSubscriptionId: null,
          subscriptionStatus: 'canceled',
          subscriptionPeriodEnd: null,
          cancelAtPeriodEnd: false,
          subscriptionPastDueSince: null,
        });
      }
    } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      // サブスクの作成・変更（申込直後のグレード付与／プラン変更・期末解約予約・状態遷移）を反映する。
      // invoice.payment_succeeded の請求書パースはAPIバージョンで揺れるため、グレード付与は
      // price.id が安定して取れる customer.subscription.* を主経路にする（created を必ず購読すること）。
      const cid = obj.customer;
      const item = (obj.items && obj.items.data && obj.items.data[0]) || {};
      const priceId = (item.price && item.price.id) || (item.plan && item.plan.id) || null;
      let grade = null;
      let planId = null;
      if (priceId) {
        try {
          const psnap = await db.collection('plans')
            .where('stripePriceId', '==', priceId).limit(1).get();
          if (!psnap.empty) { grade = Number(psnap.docs[0].data().level) || 0; planId = psnap.docs[0].id; }
        } catch (e) { /* ignore */ }
        if (grade == null && PRICE_GRADE_MAP[priceId] != null) grade = PRICE_GRADE_MAP[priceId];
      }
      const status = obj.status; // active / trialing / past_due / canceled / unpaid / incomplete...
      const periodEnd = obj.current_period_end || item.current_period_end || null;
      const snap = await db.collection('members')
        .where('stripeCustomerId', '==', cid).limit(1).get();
      if (!snap.empty) {
        const upd = {
          stripeSubscriptionId: obj.id,
          subscriptionStatus: (status === 'trialing' ? 'active' : status),
          cancelAtPeriodEnd: !!obj.cancel_at_period_end,
        };
        if (periodEnd) upd.subscriptionPeriodEnd = new Date(periodEnd * 1000);
        // 有効な間はグレードを最新プランへ追随（プラン変更に対応）。
        // 失効（canceled/unpaid 等）は customer.subscription.deleted 側で grade=0 に落とす。
        if (grade != null && (status === 'active' || status === 'trialing' || status === 'past_due')) {
          upd.grade = grade;
          upd.subscriptionPlanId = planId;
        }
        // 支払い遅延の開始時刻: 有効化で解消、past_due開始時に初回のみ記録
        if (status === 'active' || status === 'trialing') {
          upd.subscriptionPastDueSince = null;
        } else if (status === 'past_due' && !snap.docs[0].data().subscriptionPastDueSince) {
          upd.subscriptionPastDueSince = admin.firestore.FieldValue.serverTimestamp();
        }
        await snap.docs[0].ref.update(upd);
      }
    } else if (event.type === 'checkout.session.completed') {
      // 単発購入（セミナー等）の完了 → 購入記録を書き込み
      const md = obj.metadata || {};
      if (md.type === 'seminar' && md.memberId && md.seminarId) {
        const pid = md.memberId + '_' + md.seminarId;
        await db.collection('seminarPurchases').doc(pid).set({
          memberId: md.memberId,
          seminarId: md.seminarId,
          amount: obj.amount_total || null,
          stripeSessionId: obj.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }

    res.json({ received: true });
  });

// ── サブスク Checkout / カスタマーポータル（会員向け・us-central1） ──
const SUBSCRIPTION_ALLOWED_ORIGINS = [
  'https://tequiladojo.com',
  'https://www.tequiladojo.com',
  'https://tequiladojo.web.app',
  'https://tequiladojo.firebaseapp.com',
];
function safeSubOrigin(o) {
  if (typeof o === 'string' && SUBSCRIPTION_ALLOWED_ORIGINS.indexOf(o) >= 0) return o;
  return SUBSCRIPTION_ALLOWED_ORIGINS[0];
}
// サイトの対応言語のみ許可（Stripeの preferred_locales / Checkout locale に使う）。
// これにより支払い失敗時のダニングメール・請求書ページ・ポータルが会員の言語で届く。
function normalizeLang(l) {
  const s = String(l || '').toLowerCase().slice(0, 2);
  return (s === 'en' || s === 'es') ? s : 'ja';
}

// 保存済みの stripeCustomerId が現在のStripe上で有効か確認し、無効（削除済み・
// 存在しない・別モード）なら顧客を作り直して members に保存する。
// これにより checkout.sessions.create に無効な customer を渡して
// 400 (resource_missing - customer) になるのを未然に防ぐ。
async function resolveValidCustomerId(stripe, memberRef, member, memberId) {
  const existing = member && member.stripeCustomerId;
  if (existing) {
    try {
      const c = await stripe.customers.retrieve(existing);
      if (c && !c.deleted) return existing;
    } catch (e) {
      // 存在しない(resource_missing)なら作り直す。それ以外の障害は上位へ。
      if (!(e && e.code === 'resource_missing')) throw e;
    }
  }
  const customer = await stripe.customers.create({
    email: (member && (member.email || member.authEmail)) || undefined,
    name: (member && member.name) || '',
    metadata: { memberId: String(memberId || '') },
  });
  await memberRef.update({ stripeCustomerId: customer.id });
  return customer.id;
}

// 有料会員サブスクの申込 Checkout セッションを作成
exports.createSubscriptionCheckout = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    const stripe = require('stripe')(stripeSecretKey.value());
    const planId = data && data.planId;
    if (!planId) throw new functions.https.HttpsError('invalid-argument', 'planId が必要です');
    const origin = safeSubOrigin(data && data.origin);
    const lang = normalizeLang(data && data.lang); // 会員の表示言語（Stripeの言語設定に使う）

    const msnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (msnap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
    const memberRef = msnap.docs[0].ref;
    const member = msnap.docs[0].data();
    const memberId = msnap.docs[0].id;

    const pdoc = await db.collection('plans').doc(planId).get();
    if (!pdoc.exists) throw new functions.https.HttpsError('not-found', 'プランが見つかりません');
    const plan = pdoc.data();
    if (!plan.stripePriceId) {
      throw new functions.https.HttpsError('failed-precondition', 'このプランにはStripe Price IDが未設定です');
    }

    function sessionParams(cust) {
      return {
        mode: 'subscription',
        customer: cust,
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        client_reference_id: memberId,
        metadata: { memberId: memberId, planId: planId, level: String(plan.level != null ? plan.level : '') },
        success_url: origin + '/member_subscription.html?checkout=success',
        cancel_url: origin + '/member_subscription.html?checkout=cancel',
        allow_promotion_codes: true,
        locale: lang, // Checkout画面を会員の言語で表示
      };
    }

    // 保存済み顧客IDが無効なら作り直してから発行（無効なcustomerで400になるのを防ぐ）。
    // resolveValidCustomerId をすり抜けて古い customer が渡り
    // "No such customer"(resource_missing / param=customer) になった場合は、
    // 顧客を作り直して members を更新し、1回だけ再試行する（自己修復）。
    // それ以外のStripe失敗（無効/一回課金/テスト・本番不一致のPrice等）は素の
    // INTERNAL に潰さず、原因が分かるメッセージにして返す。
    async function freshCustomerId() {
      const c = await stripe.customers.create({
        email: (member && (member.email || member.authEmail)) || undefined,
        name: (member && member.name) || '',
        metadata: { memberId: String(memberId || '') },
      });
      await memberRef.update({ stripeCustomerId: c.id });
      return c.id;
    }
    // 会員の言語を Stripe顧客に設定（支払い失敗時のダニングメール・請求書ページ・
    // ポータルが会員の言語で届く）。会員ドキュメントにも保存しておく。
    async function applyLocale(cid) {
      try { await stripe.customers.update(cid, { preferred_locales: [lang] }); } catch (e) { /* 非致命 */ }
      try { await memberRef.update({ preferredLang: lang }); } catch (e) { /* 非致命 */ }
    }
    let session;
    try {
      const customerId = await resolveValidCustomerId(stripe, memberRef, member, memberId);
      await applyLocale(customerId);
      session = await stripe.checkout.sessions.create(sessionParams(customerId));
    } catch (e) {
      const staleCustomer = e && e.code === 'resource_missing' && e.param === 'customer';
      if (staleCustomer) {
        try {
          const cid = await freshCustomerId();
          await applyLocale(cid);
          session = await stripe.checkout.sessions.create(sessionParams(cid));
        } catch (e2) {
          console.error('createSubscriptionCheckout retry error', {
            memberId: memberId, planId: planId, priceId: plan.stripePriceId,
            code: e2 && e2.code, type: e2 && e2.type, message: e2 && e2.message,
          });
          throw new functions.https.HttpsError('failed-precondition',
            '申込に失敗しました: ' + ((e2 && e2.message) || 'Stripe処理でエラーが発生しました'));
        }
      } else {
        console.error('createSubscriptionCheckout stripe error', {
          memberId: memberId, planId: planId, priceId: plan.stripePriceId,
          code: e && e.code, type: e && e.type, message: e && e.message,
        });
        throw new functions.https.HttpsError('failed-precondition',
          '申込に失敗しました: ' + ((e && e.message) || 'Stripe処理でエラーが発生しました'));
      }
    }
    return { url: session.url };
  });

// 会員が自分でサブスクを管理・解約するためのカスタマーポータル
exports.createCustomerPortal = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    const stripe = require('stripe')(stripeSecretKey.value());
    const origin = safeSubOrigin(data && data.origin);
    const msnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (msnap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
    const member = msnap.docs[0].data();
    if (!member.stripeCustomerId) {
      throw new functions.https.HttpsError('failed-precondition', 'サブスク情報がありません');
    }
    let session;
    try {
      session = await stripe.billingPortal.sessions.create({
        customer: member.stripeCustomerId,
        return_url: origin + '/member_subscription.html',
      });
    } catch (e) {
      console.error('createCustomerPortal stripe error', {
        customerId: member.stripeCustomerId, code: e && e.code, type: e && e.type, message: e && e.message,
      });
      const detail = (e && e.message) ? e.message : 'Stripe処理でエラーが発生しました';
      throw new functions.https.HttpsError('failed-precondition', 'ポータルを開けませんでした: ' + detail);
    }
    return { url: session.url };
  });

// ── 有料セミナー（動画）: 単発購入 / グレード連動 / 視聴アクセス ──

// 会員の有効プランを解決（手動plan > 有効サブスクgrade > 無料）
async function resolveMemberPlan(member) {
  if (member.plan) {
    const pd = await db.collection('plans').doc(member.plan).get();
    if (pd.exists) return pd.data();
  }
  if (member.subscriptionStatus === 'active' && member.grade != null && member.grade !== '') {
    const ps = await db.collection('plans').where('level', '==', Number(member.grade)).limit(1).get();
    if (!ps.empty) return ps.docs[0].data();
  }
  return null;
}

// セミナーへのアクセス可否を判定
async function memberHasSeminarAccess(memberId, member, seminar) {
  const mode = seminar.accessMode || 'purchase';
  if (mode === 'grade' || mode === 'both') {
    const feature = seminar.requiredFeature || 'seminar';
    const plan = await resolveMemberPlan(member);
    if (plan && plan.features && plan.features[feature]) return true;
  }
  if (mode === 'purchase' || mode === 'both') {
    const pd = await db.collection('seminarPurchases').doc(memberId + '_' + seminar.id).get();
    if (pd.exists) return true;
  }
  return false;
}

async function requireMember(context) {
  if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
  }
  const msnap = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
  if (msnap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
  return { ref: msnap.docs[0].ref, id: msnap.docs[0].id, data: msnap.docs[0].data() };
}

// 単発セミナーの購入 Checkout（mode: payment）
exports.createSeminarCheckout = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    const m = await requireMember(context);
    const stripe = require('stripe')(stripeSecretKey.value());
    const seminarId = data && data.seminarId;
    if (!seminarId) throw new functions.https.HttpsError('invalid-argument', 'seminarId が必要です');
    const origin = safeSubOrigin(data && data.origin);

    const sdoc = await db.collection('seminars').doc(seminarId).get();
    if (!sdoc.exists) throw new functions.https.HttpsError('not-found', 'セミナーが見つかりません');
    const s = sdoc.data();

    // 既に購入済みなら二重購入を防ぐ
    const owned = await db.collection('seminarPurchases').doc(m.id + '_' + seminarId).get();
    if (owned.exists) throw new functions.https.HttpsError('already-exists', '既に購入済みです');

    let lineItem;
    if (s.stripePriceId) {
      lineItem = { price: s.stripePriceId, quantity: 1 };
    } else if (s.price != null && Number(s.price) > 0) {
      lineItem = {
        price_data: { currency: 'jpy', product_data: { name: s.title || 'セミナー' }, unit_amount: Math.round(Number(s.price)) },
        quantity: 1,
      };
    } else {
      throw new functions.https.HttpsError('failed-precondition', 'このセミナーには価格が設定されていません');
    }

    // 保存済み顧客IDが無効なら作り直してから発行（無効なcustomerで400になるのを防ぐ）
    const customerId = await resolveValidCustomerId(stripe, m.ref, m.data, m.id);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [lineItem],
      client_reference_id: m.id,
      metadata: { type: 'seminar', memberId: m.id, seminarId: seminarId },
      success_url: origin + '/seminars.html?purchase=success',
      cancel_url: origin + '/seminars.html?purchase=cancel',
    });
    return { url: session.url };
  });

// 視聴アクセス検証つきで vimeoId を返す（アクセス不可なら locked）
exports.getSeminarVideo = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    const m = await requireMember(context);
    const seminarId = data && data.seminarId;
    if (!seminarId) throw new functions.https.HttpsError('invalid-argument', 'seminarId が必要です');
    const sdoc = await db.collection('seminars').doc(seminarId).get();
    if (!sdoc.exists) throw new functions.https.HttpsError('not-found', 'セミナーが見つかりません');
    const s = Object.assign({ id: seminarId }, sdoc.data());
    const ok = await memberHasSeminarAccess(m.id, m.data, s);
    if (!ok) return { locked: true };
    const src = await db.collection('seminarSources').doc(seminarId).get();
    return { vimeoId: src.exists ? (src.data().vimeoId || '') : '' };
  });

// 会員が購入済みのセミナーID一覧（UI表示用）
exports.getMyPurchasedSeminars = functions
  .https.onCall(async (data, context) => {
    const m = await requireMember(context);
    const snap = await db.collection('seminarPurchases').where('memberId', '==', m.id).get();
    return { ids: snap.docs.map((d) => d.data().seminarId) };
  });

// ── 会員作成時に Stripe 顧客を作成 ──
exports.createStripeCustomer = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .firestore.document('members/{uid}')
  .onCreate(async (snap) => {
    const stripe = require('stripe')(stripeSecretKey.value());
    const data = snap.data();
    const email = data.email || data.authEmail;
    if (!email) return;
    try {
      const customer = await stripe.customers.create({
        email: email,
        name: data.name || '',
      });
      await snap.ref.update({ stripeCustomerId: customer.id });
    } catch (err) {
      console.error('Stripe顧客作成失敗:', err.message);
    }
  });

// ── 会員削除時にFirebase Authアカウントも削除 ──
// 実際のFirebase Auth UIDは members ドキュメントの authUid フィールドに入っている。
// ドキュメントID（現行モデルでは realId）はAuth UIDと一致しないため、authUid を優先し、
// 無い場合のみ従来どおりドキュメントIDにフォールバックする（旧データ互換）。
// これによりハード削除時にAuthアカウントが残る（孤児Auth）問題を防止する。
exports.deleteMemberAuth = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .firestore.document('members/{uid}')
  .onDelete(async (snap, context) => {
    const data = (snap && snap.data()) || {};
    const authUid = data.authUid || context.params.uid;
    try {
      await admin.auth().deleteUser(authUid);
      console.log('Auth削除成功:', authUid);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.log('Auth既に削除済み:', authUid);
      } else {
        console.error('Auth削除失敗:', err.message);
      }
    }
  });

// ── authEmailからauthUidを補完するHTTPS Function（旧データ移行用） ──
exports.fixMemberAuthUids = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onRequest(async (req, res) => {
    if (req.query.secret !== 'tequiladojo-admin-fix') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const snap = await db.collection('members').get();
    const results = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.authEmail && !d.authUid) {
        try {
          const userRecord = await admin.auth().getUserByEmail(d.authEmail);
          await doc.ref.update({ authUid: userRecord.uid });
          results.push({ id: doc.id, authEmail: d.authEmail, uid: userRecord.uid, status: 'fixed' });
        } catch (e) {
          results.push({ id: doc.id, authEmail: d.authEmail, status: 'error', message: e.message });
        }
      }
    }
    res.json({ fixed: results.length, results });
  });

// ── 管理者によるAuth操作（作成・削除・メール/パスワード変更） ──
exports.adminAuthOperation = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です');
    }
    const callerDoc = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (callerDoc.empty || callerDoc.docs[0].data().role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', '管理者権限が必要です');
    }

    const { operation, memberId, email, password, authUid } = data;

    if (operation === 'create') {
      const authEmail = email || (memberId + '@tequiladojo.member');
      try {
        const user = await admin.auth().createUser({ email: authEmail, password: password });
        await db.collection('members').doc(memberId).update({ authUid: user.uid });
        return { success: true, uid: user.uid };
      } catch (e) {
        throw new functions.https.HttpsError('already-exists', e.message);
      }
    } else if (operation === 'delete') {
      try {
        await admin.auth().deleteUser(authUid);
        return { success: true };
      } catch (e) {
        throw new functions.https.HttpsError('not-found', e.message);
      }
    } else if (operation === 'updateEmail') {
      try {
        await admin.auth().updateUser(authUid, { email: data.email });
        return { success: true };
      } catch (e) {
        throw new functions.https.HttpsError('not-found', e.message);
      }
    } else if (operation === 'updatePassword') {
      try {
        await admin.auth().updateUser(authUid, { password: password });
        return { success: true };
      } catch (e) {
        throw new functions.https.HttpsError('not-found', e.message);
      }
    }
    throw new functions.https.HttpsError('invalid-argument', '不明な操作です');
  });

// ── 管理者による強制本登録（emailVerifiedをtrueに設定） ──
exports.forceVerifyEmail = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です');
    }
    const callerSnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (callerSnap.empty || callerSnap.docs[0].data().role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', '管理者権限が必要です');
    }
    const { authUid, email } = data;
    try {
      await admin.auth().updateUser(authUid, { emailVerified: true, email: email });
      return { success: true };
    } catch (e) {
      throw new functions.https.HttpsError('not-found', e.message);
    }
  });

// ── テストユーザー管理（オーナー限定・シークレット非依存） ──
// admin_testuser.html から呼び出す。作成（create）と物理削除（hardDelete）。
// hardDelete は安全のため isTest:true の会員のみ対象。
exports.manageTestUser = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です');
    }
    const callerSnap = await db.collection('members')
      .where('authUid', '==', context.auth.uid).limit(1).get();
    if (callerSnap.empty || callerSnap.docs[0].data().role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');
    }
    const op = (data && data.operation) || '';
    const memberId = ((data && data.memberId) || '').trim();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(memberId)) {
      throw new functions.https.HttpsError('invalid-argument', 'IDが不正です（英数字1〜20文字）');
    }
    const authEmail = memberId + '@tequiladojo.member';

    if (op === 'create') {
      const password = (data && data.password) || '';
      const nickname = (((data && data.nickname) || ('テスト' + memberId)) + '').trim();
      if (password.length < 6) {
        throw new functions.https.HttpsError('invalid-argument', 'パスワードは6文字以上が必要です');
      }
      let uid;
      try {
        const existing = await auth.getUserByEmail(authEmail).catch(() => null);
        if (existing) { uid = existing.uid; await auth.updateUser(uid, { password }); }
        else { const u = await auth.createUser({ email: authEmail, password }); uid = u.uid; }
      } catch (e) {
        throw new functions.https.HttpsError('internal', 'Auth作成に失敗しました: ' + e.message);
      }
      const today = new Date().toISOString().slice(0, 10);
      const ref = db.collection('members').doc(memberId);
      const snap = await ref.get();
      if (snap.exists) {
        await ref.set({ authUid: uid, isTest: true, nickname }, { merge: true });
      } else {
        await ref.set({
          authUid: uid, realId: memberId, displayId: memberId, memberId: memberId,
          email: null, status: 'active', role: 'member',
          nickname, registeredAt: today,
          visitCount: 0, totalAmount: 0, totalTequila: 0, isTest: true,
        });
      }
      await db.collection('memberIndex').doc(memberId).set({ email: authEmail });
      return { success: true, uid };
    }

    if (op === 'hardDelete') {
      const snap = await db.collection('members').doc(memberId).get();
      if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', '会員が見つかりません');
      }
      const m = snap.data() || {};
      if (m.isTest !== true) {
        throw new functions.https.HttpsError('permission-denied', 'テストユーザー(isTest:true)のみ物理削除できます');
      }
      // Auth削除（authUid、無ければメールから解決）
      let authDeleted = false;
      try {
        let uid = m.authUid;
        if (!uid) { const u = await auth.getUserByEmail(authEmail).catch(() => null); uid = u && u.uid; }
        if (uid) { await auth.deleteUser(uid); authDeleted = true; }
      } catch (e) { /* Authが無くてもFirestore削除は続行 */ }
      // 関連データ削除（visits / orders / cocktailOrders / memberPrivate / memberIndex / members）
      const visitsSnap = await db.collection('visits').where('memberId', '==', memberId).get();
      const visitIds = visitsSnap.docs.map((d) => d.id);
      const orderRefs = [];
      const seen = {};
      const pushRef = (r) => { const k = r.path; if (!seen[k]) { seen[k] = true; orderRefs.push(r); } };
      for (let i = 0; i < visitIds.length; i += 10) {
        const chunk = visitIds.slice(i, i + 10);
        const s1 = await db.collection('orders').where('visitKey', 'in', chunk).get();
        s1.docs.forEach((d) => pushRef(d.ref));
        const s1b = await db.collection('orders').where('visitId', 'in', chunk).get();
        s1b.docs.forEach((d) => pushRef(d.ref));
        const s2 = await db.collection('cocktailOrders').where('visitKey', 'in', chunk).get();
        s2.docs.forEach((d) => pushRef(d.ref));
      }
      const allRefs = [];
      visitsSnap.docs.forEach((d) => allRefs.push(d.ref));
      orderRefs.forEach((r) => allRefs.push(r));
      for (let i = 0; i < allRefs.length; i += 450) {
        const b = db.batch();
        allRefs.slice(i, i + 450).forEach((r) => b.delete(r));
        await b.commit();
      }
      const fin = db.batch();
      fin.delete(db.collection('members').doc(memberId));
      fin.delete(db.collection('memberIndex').doc(memberId));
      fin.delete(db.collection('memberPrivate').doc(memberId));
      await fin.commit();
      return { success: true, authDeleted, deletedVisits: visitsSnap.size, deletedOrders: orderRefs.length };
    }

    throw new functions.https.HttpsError('invalid-argument', '不明な操作です');
  });

// ═══════════════════════════════════════════════════════════════════
//  会員セルフ来店（QR）＆ オンライン注文
//  visits/orders はスタッフ限定書き込みのため、会員操作はここ経由で行う。
// ═══════════════════════════════════════════════════════════════════

// 認証済み会員本人を authUid から解決する
async function resolveMember(context) {
  if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
  }
  const snap = await db.collection('members')
    .where('authUid', '==', context.auth.uid).limit(1).get();
  if (snap.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
  return { id: snap.docs[0].id, data: snap.docs[0].data() };
}

// 現在の店頭ステータス（open判定・営業日）を取得
async function getStoreState() {
  const ss = await db.collection('storeStatus').doc('current').get();
  if (!ss.exists) return { open: false, sessionDate: null };
  const d = ss.data();
  return { open: d.status === 'open', sessionDate: d.sessionDate || null };
}

// 会員の「未退場」来店を営業日で探す（realId・旧displayId両対応）
async function findActiveVisit(member, sessionDate) {
  if (!sessionDate) return null;
  const idSet = [member.id];
  if (member.data.displayId) idSet.push(String(member.data.displayId));
  if (member.data.memberId) idSet.push(String(member.data.memberId));
  let visitKey = null;
  for (const mid of [...new Set(idSet)]) {
    const vs = await db.collection('visits')
      .where('memberId', '==', mid).where('visitDate', '==', sessionDate).get();
    vs.forEach((d) => { if (!d.data().checkoutTime) visitKey = d.id; });
  }
  return visitKey;
}

// ── 店舗来店QRトークンの再発行（スタッフ） ──
exports.rotateCheckinToken = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const token = 'CK' + Math.random().toString(36).slice(2, 10).toUpperCase()
      + Date.now().toString(36).toUpperCase();
    await db.collection('settings').doc('checkinConfig').set({
      token, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, token };
  });

// ── 会員のセルフ来店リクエスト（来店QRスキャン） ──
// トークン照合＋開店中チェックの上、承認待ちリクエストを作成する。
// 実際の来店確定・来店時刻はスタッフ承認時に確定する。
exports.requestCheckin = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const member = await resolveMember(context);
    const raw = (data && data.token ? String(data.token) : '').trim();
    // URL形式（...?checkin=xxx）で渡された場合はクエリを抽出
    let token = raw;
    const m = raw.match(/[?&]checkin=([^&\s]+)/);
    if (m) token = decodeURIComponent(m[1]);

    const cfg = await db.collection('settings').doc('checkinConfig').get();
    const validToken = cfg.exists ? (cfg.data().token || '') : '';
    if (!validToken) {
      throw new functions.https.HttpsError('failed-precondition', '来店QRが未設定です。スタッフにお知らせください。');
    }
    if (!token || token !== validToken) {
      throw new functions.https.HttpsError('invalid-argument', '来店QRが正しくありません。店舗のQRを読み取ってください。');
    }
    const store = await getStoreState();
    if (!store.open) {
      throw new functions.https.HttpsError('failed-precondition', '現在は営業時間外です。');
    }
    // 既に来店中（承認済み・未退場）なら成功として返す
    const active = await findActiveVisit(member, store.sessionDate);
    if (active) return { ok: true, status: 'checkedin', visitKey: active };
    // 承認待ちの重複を防ぐ
    const existReq = await db.collection('checkinRequests')
      .where('memberId', '==', member.id)
      .where('sessionDate', '==', store.sessionDate)
      .where('status', '==', 'pending').limit(1).get();
    if (!existReq.empty) return { ok: true, status: 'pending', requestId: existReq.docs[0].id };

    const name = member.data.nickname || member.data.name || member.data.displayId || member.id;
    const ref = await db.collection('checkinRequests').add({
      memberId: member.id,
      memberName: name,
      displayId: member.data.displayId || member.data.memberId || null,
      sessionDate: store.sessionDate,
      status: 'pending',
      source: 'qr',
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, status: 'pending', requestId: ref.id };
  });

// ── 会員の現在の来店状況（注文可否判定用） ──
exports.getMyVisitStatus = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    try {
      const member = await resolveMember(context);
      const store = await getStoreState();
      const visitKey = store.open ? await findActiveVisit(member, store.sessionDate) : null;
      let pending = false;
      if (store.open && store.sessionDate) {
        const pr = await db.collection('checkinRequests')
          .where('memberId', '==', member.id)
          .where('sessionDate', '==', store.sessionDate)
          .where('status', '==', 'pending').limit(1).get();
        pending = !pr.empty;
      }
      return jsonSafe({
        storeOpen: store.open,
        sessionDate: store.sessionDate,
        checkedIn: !!visitKey,
        visitKey: visitKey || null,
        pending,
        memberId: member.id,
        memberName: member.data.nickname || member.data.name || member.id,
      });
    } catch (e) {
      if (e instanceof functions.https.HttpsError) throw e;
      console.error('[getMyVisitStatus] error:', (e && e.stack) || e);
      throw new functions.https.HttpsError('failed-precondition', 'VS-error: ' + ((e && e.message) || e));
    }
  });

// ── 会員のオンライン注文（来店確定者のみ） ──
// 商品マスタをサーバー側で検証し価格を確定して orders を作成する。
exports.placeMemberOrder = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const member = await resolveMember(context);
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (!items.length) throw new functions.https.HttpsError('invalid-argument', '注文内容がありません');
    if (items.length > 30) throw new functions.https.HttpsError('invalid-argument', '一度に注文できる品数を超えています');

    const store = await getStoreState();
    if (!store.open) throw new functions.https.HttpsError('failed-precondition', '現在は営業時間外です');
    if (!store.sessionDate) throw new functions.https.HttpsError('failed-precondition', '営業セッションが確認できません');
    const visitKey = await findActiveVisit(member, store.sessionDate);
    if (!visitKey) {
      throw new functions.https.HttpsError('failed-precondition',
        '来店登録が必要です。店舗のQRから来店手続きを行い、スタッフの承認をお待ちください。');
    }

    // 商品マスタ検証・価格算出（テキーラ／その他ドリンクのみ）
    const ALLOWED = { tequila: 'bottleData', other: 'otherBottles', misc: 'miscProducts' };
    const resolved = [];
    for (const it of items) {
      const pt = String(it.productType || '');
      const pid = String(it.productId || '');
      if (!ALLOWED[pt]) throw new functions.https.HttpsError('invalid-argument', '注文できない商品種別です: ' + pt);
      if (!pid) throw new functions.https.HttpsError('invalid-argument', '商品IDがありません');
      const doc = await db.collection(ALLOWED[pt]).doc(pid).get();
      if (!doc.exists) throw new functions.https.HttpsError('not-found', '商品が見つかりません');
      const p = doc.data();
      const isMl = (pt === 'tequila' || pt === 'other');
      let qty = Math.round(Number(it.qty || 0));
      if (isMl) {
        if (!(qty > 0) || qty > 500) throw new functions.https.HttpsError('invalid-argument', 'ml数が不正です');
      } else {
        if (!(qty > 0) || qty > 99) throw new functions.https.HttpsError('invalid-argument', '数量が不正です');
      }
      if (pt === 'tequila') {
        const vis = p.visibility;
        const orderable = (vis === '0' || vis === 0 || vis === false || vis === undefined || vis === null);
        if (!orderable) throw new functions.https.HttpsError('failed-precondition', 'この商品は現在注文できません');
      }
      const unitPrice = Number(p.price != null ? p.price
        : (p.unitPrice != null ? p.unitPrice : (p.price10 != null ? p.price10 : 0))) || 0;
      const name = (pt === 'tequila')
        ? (p.bottleEs || p.bottleEsBase || p.bottleJa || p.name || pid)
        : (pt === 'other')
          ? (p.bottleEn || p.bottleName || p.name || p.bottleJa || pid)
          : (p.name || p.productName || pid);
      resolved.push({ productType: pt, productId: pid, qty, unit: isMl ? 'ml' : '個', unitPrice, productName: name });
    }

    // 注文時刻（営業時間・日跨ぎは24h+表記に合わせる）
    let openHHMM = null;
    try {
      const sess = await db.collection('sessions').where('date', '==', store.sessionDate).limit(1).get();
      if (!sess.empty) {
        const ot = String(sess.docs[0].data().openTime || '');
        if (ot.length >= 4) openHHMM = parseInt(ot.slice(0, 4), 10);
      }
    } catch (e) { /* noop */ }
    const jd = new Date(Date.now() + 9 * 3600 * 1000); // JST
    let oh = jd.getUTCHours(); const omin = jd.getUTCMinutes(); const osec = jd.getUTCSeconds();
    if (openHHMM != null && (oh * 100 + omin) < openHHMM) oh += 24;
    const orderTime = String(oh).padStart(2, '0') + String(omin).padStart(2, '0') + String(osec).padStart(2, '0');

    // orderGroupId 採番（会員の来店内で連番）・batchId は本注文で一意
    const vkOrders = await db.collection('orders').where('visitKey', '==', visitKey).get();
    let maxG = 0;
    vkOrders.forEach((d) => {
      const g = d.data().orderGroupId || '';
      const n = parseInt(g.slice(visitKey.length), 10) || 0;
      if (n > maxG) maxG = n;
    });
    const orderGroupId = visitKey + String(maxG + 1).padStart(2, '0');
    const batchId = store.sessionDate + 'M' + Date.now().toString(36).slice(-5).toUpperCase();

    const batch = db.batch();
    const created = [];
    resolved.forEach((r, i) => {
      const ref = db.collection('orders').doc();
      const od = {
        orderDate: store.sessionDate, orderTime,
        customerId: member.id, visitKey, orderGroupId, batchId,
        itemSeq: i + 1, productCode: r.productId, productName: r.productName,
        productType: r.productType, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice,
        blindId: 0, blindMarkId: null, served: 1, source: 'online',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      batch.set(ref, od);
      created.push({ id: ref.id, data: od });
    });
    await batch.commit();
    created.forEach((c) => writeServerJournal('create', 'orders', c.id, null, c.data, 'placeMemberOrder'));
    return { ok: true, count: created.length, orderGroupId, batchId };
  });

// ── Stripe Terminal SDK（WisePad 3 等のBluetooth端末・アプリ組込用） ──────
// Androidアプリ（terminal-app-android）から呼ぶ。スタッフ認証必須。

// 接続トークン発行（Terminal SDK の ConnectionTokenProvider が要求する）
exports.terminalConnectionToken = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const stripe = require('stripe')(stripeSecretKey.value());
    const token = await stripe.terminal.connectionTokens.create();
    return { secret: token.secret };
  });

// 決済用 PaymentIntent を作成し client_secret を返す（SDKが読み取り〜確定する）。
// JPYはゼロ十進のため amount は「円」そのまま。capture は即時。
exports.terminalCreatePaymentIntent = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const stripe = require('stripe')(stripeSecretKey.value());
    const amount = Math.round(Number(data && data.amount));
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new functions.https.HttpsError('invalid-argument', '金額（amount, 円）が不正です');
    }
    if (amount > 1000000) {
      throw new functions.https.HttpsError('invalid-argument', '金額が上限（¥1,000,000）を超えています');
    }
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'jpy',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description: (data && data.description) ? String(data.description).slice(0, 200) : 'テキーラ道場 お会計',
      metadata: { source: 'wisepad3' },
    });
    return { id: pi.id, clientSecret: pi.client_secret };
  });

// 決済のカード情報（ブランド・読み取り方法）を PaymentIntent から取得する。
// 対面(card_present)決済の brand（visa/jcb等）と read_method（contactless=タッチ / contact=挿入）を返す。
// 管理ページ「カード決済ログ」が paymentIntentId を渡して呼び、結果を各ログに保存(キャッシュ)する。
exports.terminalChargeInfo = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    const stripe = require('stripe')(stripeSecretKey.value());
    const id = data && data.paymentIntentId;
    if (!id || typeof id !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'paymentIntentId が必要です');
    }
    const pi = await stripe.paymentIntents.retrieve(String(id), { expand: ['latest_charge'] });
    const ch = pi && pi.latest_charge;
    const cp = ch && ch.payment_method_details && ch.payment_method_details.card_present;
    if (!cp) return { brand: null, readMethod: null, last4: null };
    return { brand: cp.brand || null, readMethod: cp.read_method || null, last4: cp.last4 || null };
  });

// サブスクリプション決済（オンライン継続課金）の履歴を Stripe の請求書(invoice)から取得する。
// 管理ページ「カード決済ログ」の種別=サブスクで表示する（terminalPayments とは別系統）。
exports.subscriptionPayments = functions
  .runWith({ secrets: ['STRIPE_SECRET_KEY'] })
  .https.onCall(async (data, context) => {
    await assertStaff(context);
    try {
    const stripe = require('stripe')(stripeSecretKey.value());
    const limit = Math.min(Math.max(Number(data && data.limit) || 100, 1), 100);
    const params = { limit, status: 'paid' };
    if (data && data.sinceSec) params.created = { gte: Math.floor(Number(data.sinceSec)) };
    const inv = await stripe.invoices.list(params);
    const rows = (inv.data || []).map(function (v) {
      const line = (v.lines && v.lines.data && v.lines.data[0]) || {};
      const priceId = (line.price && line.price.id)
        || (line.pricing && line.pricing.price_details && line.pricing.price_details.price)
        || (line.plan && line.plan.id) || null;
      return {
        id: v.id,
        number: v.number || null,
        created: v.created || null,
        amount: (v.amount_paid != null ? v.amount_paid : (v.total || 0)),
        currency: v.currency || 'jpy',
        customerId: (typeof v.customer === 'string' ? v.customer : (v.customer && v.customer.id)) || null,
        customerEmail: v.customer_email || null,
        customerName: v.customer_name || null,
        priceId: priceId,
        status: v.status || null,
        subscription: (typeof v.subscription === 'string' ? v.subscription : (v.subscription && v.subscription.id)) || null,
        hostedInvoiceUrl: v.hosted_invoice_url || null,
      };
    });
    return { rows: rows, hasMore: !!inv.has_more };
    } catch (e) {
      // Stripe等の実際のエラーを internal で潰さず、メッセージを返す
      throw new functions.https.HttpsError('internal', 'サブスク取得エラー: ' + ((e && e.message) ? e.message : String(e)));
    }
  });

// ── 個人テキーラログ: 道場注文からの自動登録 ─────────────────────
// 会員(有料)の道場注文(tequila/cocktail)を個人ログ(source=auto)へ同期する。
// 冪等: ログID = 'auto_' + orderId。注文の追加/編集/削除に追従。
// 会員のメモ・評価は自動更新で上書きしない（初回作成時のみ初期化）。

// 会員の有料レベルを解決（手動plan優先 > 有効サブスクgrade > 0）
async function memberPaidLevel(m) {
  if (!m) return 0;
  if (m.plan) {
    const pd = await db.collection('plans').doc(String(m.plan)).get();
    return pd.exists ? (Number(pd.data().level) || 0) : 0;
  }
  if (m.subscriptionStatus === 'active' && m.grade != null && m.grade !== '') {
    const ps = await db.collection('plans').where('level', '==', Number(m.grade)).limit(1).get();
    if (!ps.empty) return Number(ps.docs[0].data().level) || 0;
    return Number(m.grade) || 0;
  }
  return 0;
}

// 注文 → ログ項目（対象外なら null）
function orderToLogFields(o) {
  if (!o || o.served === 0 || o.isAdjustment) return null;
  const pt = String(o.productType || '');
  let bottleId = null; let style = null; let ml = 0;
  if (pt === 'tequila') { bottleId = o.productCode; style = 'straight'; ml = Number(o.qty) || 0; } else if (pt === 'cocktail') { bottleId = o.baseProductCode || null; style = 'cocktail'; ml = Number(o.baseSpiritMl) || 0; } else return null;
  if (!bottleId) return null;
  const od = String(o.orderDate || ''); const ot = String(o.orderTime || '');
  if (od.length < 6) return null;
  const drunkAt = '20' + od.slice(0, 6) + (ot.length >= 4 ? ot.slice(0, 4) : '0000'); // JST
  return { bottleId: String(bottleId), style, amountMl: ml, drunkAt };
}

// 1注文分を同期（作成/更新/削除）。orderData が null なら削除扱い。
async function syncOneOrderLog(orderId, orderData) {
  const logRef = db.collection('tequilaLogs').doc('auto_' + orderId);
  const mapped = orderData ? orderToLogFields(orderData) : null;
  // 対象外/削除 → 対応ログを削除
  if (!mapped) { await logRef.delete().catch(() => {}); return 'deleted'; }
  const customerId = orderData.customerId;
  if (!customerId) { await logRef.delete().catch(() => {}); return 'deleted'; }
  const mdoc = await db.collection('members').doc(String(customerId)).get();
  if (!mdoc.exists) { await logRef.delete().catch(() => {}); return 'skipped'; }
  const m = mdoc.data();
  const level = await memberPaidLevel(m);
  // 未有料 → 新規作成しない（既存ログは残す＝解約後も保持）
  if (!(level > 0) || !m.authUid) return 'skipped';
  // ボトル名（denormalize）
  let bottleName = orderData.productName || mapped.bottleId;
  try { const bd = await db.collection('bottles').doc(mapped.bottleId).get(); if (bd.exists) { const b = bd.data(); bottleName = b.bottleJa || b.bottleEs || b.bottleEn || bottleName; } } catch (e) { /* noop */ }
  const existing = await logRef.get();
  const base = {
    authUid: m.authUid, memberId: String(m.memberId || customerId), memberName: String(m.nickname || m.name || ''),
    drunkAt: mapped.drunkAt, drunkAtLocal: mapped.drunkAt, tz: 'Asia/Tokyo',
    bottleId: mapped.bottleId, bottleName, style: mapped.style, amountMl: mapped.amountMl,
    barId: 'B00000', barText: null, source: 'auto', orderRef: orderId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!existing.exists) { base.note = null; base.rating = 0; base.createdAt = admin.firestore.FieldValue.serverTimestamp(); }
  await logRef.set(base, { merge: true });
  return existing.exists ? 'updated' : 'created';
}

// Firestoreトリガー: 注文の書込に追従
exports.syncTequilaLogFromOrder = functions.region('asia-northeast1')
  .firestore.document('orders/{orderId}')
  .onWrite(async (change, context) => {
    try {
      const after = change.after.exists ? change.after.data() : null;
      await syncOneOrderLog(context.params.orderId, after);
    } catch (e) { console.error('syncTequilaLogFromOrder', e.message); }
    return null;
  });

// 過去注文からの取り込み（バックフィル）。
// - 会員本人が呼ぶと自分の分を取り込む（途中入会時など）。
// - スタッフは memberId 指定で任意会員分を取り込める。
exports.backfillTequilaLogs = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.firebase && context.auth.token.firebase.sign_in_provider === 'anonymous') {
      throw new functions.https.HttpsError('unauthenticated', 'ログインが必要です');
    }
    const claimRole = context.auth.token.role;
    const isStaffCaller = (claimRole === 'owner' || claimRole === 'staff');
    let memberId = data && data.memberId;
    if (!isStaffCaller) {
      // 会員は自分の分のみ
      const ms = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
      if (ms.empty) throw new functions.https.HttpsError('not-found', '会員情報が見つかりません');
      memberId = ms.docs[0].id;
    }
    if (!memberId) throw new functions.https.HttpsError('invalid-argument', 'memberId が必要です');
    const snap = await db.collection('orders').where('customerId', '==', String(memberId)).get();
    let created = 0; let updated = 0; let skipped = 0;
    for (const d of snap.docs) {
      const res = await syncOneOrderLog(d.id, d.data());
      if (res === 'created') created++; else if (res === 'updated') updated++; else skipped++;
    }
    // 一度取り込んだら会員に実行済みフラグを立てる（会員ページの初回バナー制御用）
    await db.collection('members').doc(String(memberId))
      .set({ tequilaLogBackfilledAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {});
    return { ok: true, orders: snap.size, created, updated, skipped };
  });

// ── SwitchBot 温湿度センサー ───────────────────────────────────────
// 店内の SwitchBot 温湿度計（ハブ連携）の値を定期取得して settings/envSensor に
// キャッシュし、注文作成時（orders onCreate）にその値を注文へスタンプする。
// 秘密情報は Secret Manager に設定:
//   firebase functions:secrets:set SWITCHBOT_TOKEN
//   firebase functions:secrets:set SWITCHBOT_SECRET
// 複数台ある場合は settings/envSensorConfig.deviceId を手動設定（未設定なら自動検出）。
const switchbotToken = defineSecret('SWITCHBOT_TOKEN');
const switchbotSecret = defineSecret('SWITCHBOT_SECRET');

// SwitchBot v1.1 API 署名ヘッダを生成
function switchbotHeaders(token, secret) {
  const crypto = require('crypto');
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = crypto.createHmac('sha256', secret)
    .update(Buffer.from(token + t + nonce, 'utf-8'))
    .digest('base64').toUpperCase();
  return { 'Authorization': token, 'sign': sign, 't': t, 'nonce': nonce, 'Content-Type': 'application/json' };
}

async function switchbotGet(path, token, secret) {
  const resp = await fetch('https://api.switch-bot.com' + path, { method: 'GET', headers: switchbotHeaders(token, secret) });
  const json = await resp.json();
  if (!json || json.statusCode !== 100) {
    throw new Error('SwitchBot API error: ' + (json && (json.message || json.statusCode)) + ' (HTTP ' + resp.status + ')');
  }
  return json.body;
}

// 温湿度計デバイスIDを解決（settings/envSensorConfig.deviceId 優先。無ければ自動検出しキャッシュ）
async function resolveSwitchbotDeviceId(token, secret) {
  const cfg = await db.collection('settings').doc('envSensorConfig').get();
  if (cfg.exists && cfg.data().deviceId) return cfg.data().deviceId;
  const body = await switchbotGet('/v1.1/devices', token, secret);
  const list = (body && body.deviceList) || [];
  // 温湿度計: Meter / MeterPlus / Meter Pro / WoIOSensor(屋外) など。Hub 2 も温湿度を持つ。
  const meter = list.find((d) => /meter|wosensor|woiosensor|hub 2/i.test(String(d.deviceType || '')));
  if (!meter) throw new Error('温湿度計（Meter）デバイスが見つかりません。settings/envSensorConfig.deviceId を手動設定してください');
  await db.collection('settings').doc('envSensorConfig').set({
    deviceId: meter.deviceId, deviceType: meter.deviceType || null, deviceName: meter.deviceName || '',
    autoDetectedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return meter.deviceId;
}

// 5分毎に温湿度を取得して settings/envSensor に保存
exports.refreshEnvSensor = functions.region('asia-northeast1')
  .runWith({ secrets: [switchbotToken, switchbotSecret] })
  .pubsub.schedule('every 5 minutes').timeZone('Asia/Tokyo')
  .onRun(async () => {
    const token = switchbotToken.value();
    const secret = switchbotSecret.value();
    if (!token || !secret) { console.warn('refreshEnvSensor: SwitchBot secrets 未設定'); return null; }
    try {
      const deviceId = await resolveSwitchbotDeviceId(token, secret);
      const status = await switchbotGet('/v1.1/devices/' + encodeURIComponent(deviceId) + '/status', token, secret);
      const temperature = (typeof status.temperature === 'number') ? status.temperature : null;
      const humidity = (typeof status.humidity === 'number') ? status.humidity : null;
      await db.collection('settings').doc('envSensor').set({
        temperature, humidity, deviceId, deviceType: status.deviceType || null,
        ok: (temperature !== null || humidity !== null),
        readAt: admin.firestore.FieldValue.serverTimestamp(), error: null
      }, { merge: true });
      return null;
    } catch (e) {
      console.error('refreshEnvSensor error:', e);
      await db.collection('settings').doc('envSensor').set({
        ok: false, error: String((e && e.message) || e),
        readAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return null;
    }
  });

// JST の YYMMDD を返す
function jstYmd6(date) {
  const j = new Date(date.getTime() + 9 * 3600 * 1000);
  const y = j.getUTCFullYear() % 100;
  return String(y).padStart(2, '0') + String(j.getUTCMonth() + 1).padStart(2, '0') + String(j.getUTCDate()).padStart(2, '0');
}

// 注文作成時に、キャッシュ済みの温湿度を注文へスタンプ
// ・既に temperature/humidity がある場合はスキップ（手動入力・再作成を尊重）
// ・キャッシュが古すぎる（30分超）／取得失敗中はスタンプしない（誤記録防止）
// ・orderDate が当日/前日(JST)でない場合はスタンプしない（過去日の手入力注文への誤記録防止）
const ENV_MAX_AGE_MS = 30 * 60 * 1000;
exports.stampOrderEnv = functions.region('asia-northeast1')
  .firestore.document('orders/{orderId}')
  .onCreate(async (snap) => {
    const data = snap.data() || {};
    if (data.temperature != null || data.humidity != null) return null;
    if (data.orderDate) {
      const now = new Date();
      const today = jstYmd6(now);
      const yest = jstYmd6(new Date(now.getTime() - 24 * 3600 * 1000));
      if (data.orderDate !== today && data.orderDate !== yest) return null;
    }
    try {
      const env = await db.collection('settings').doc('envSensor').get();
      if (!env.exists) return null;
      const e = env.data();
      if (e.ok === false) return null;
      const readAtMs = (e.readAt && e.readAt.toMillis) ? e.readAt.toMillis() : 0;
      if (!readAtMs || (Date.now() - readAtMs) > ENV_MAX_AGE_MS) return null;
      const upd = {};
      if (typeof e.temperature === 'number') upd.temperature = e.temperature;
      if (typeof e.humidity === 'number') upd.humidity = e.humidity;
      if (!Object.keys(upd).length) return null;
      upd.envAt = e.readAt;
      upd.envSource = 'switchbot';
      await snap.ref.set(upd, { merge: true });
      return null;
    } catch (err) {
      console.error('stampOrderEnv error:', err);
      return null;
    }
  });

// 外気（千葉市中央区長洲1丁目付近）の気温・湿度を Open-Meteo から取得（APIキー不要・無料・商用可）
const CHIBA_LAT = 35.598, CHIBA_LON = 140.116;
async function fetchOutdoorWeather() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + CHIBA_LAT + '&longitude=' + CHIBA_LON +
      '&current=temperature_2m,relative_humidity_2m&timezone=Asia%2FTokyo';
    const resp = await fetch(url);
    const json = await resp.json();
    const c = json && json.current;
    if (!c) return { t: null, h: null };
    return {
      t: (typeof c.temperature_2m === 'number') ? c.temperature_2m : null,
      h: (typeof c.relative_humidity_2m === 'number') ? c.relative_humidity_2m : null
    };
  } catch (e) { console.warn('fetchOutdoorWeather error:', e); return { t: null, h: null }; }
}

// 毎時、店内(settings/envSensor)＋外気(Open-Meteo)の温湿度を envLog に記録（時間毎グラフ・月次分析用）
// ・doc id = YYYYMMDDHH（JST）で1時間1件。冪等（merge）。
// ・店内キャッシュが20分超で古い/取得失敗中は店内値は欠測扱い（null）。外気は毎回取得。
// 負荷: 実行24回/日・書込24件/日・外部API24回/日と極小。
exports.logEnvHourly = functions.region('asia-northeast1')
  .pubsub.schedule('every 60 minutes').timeZone('Asia/Tokyo')
  .onRun(async () => {
    try {
      const env = await db.collection('settings').doc('envSensor').get();
      const e = env.exists ? env.data() : {};
      const readAtMs = (e.readAt && e.readAt.toMillis) ? e.readAt.toMillis() : 0;
      const indoorFresh = e.ok !== false && readAtMs && (Date.now() - readAtMs) <= 20 * 60 * 1000;
      const out = await fetchOutdoorWeather();
      const j = new Date(Date.now() + 9 * 3600 * 1000); // JST
      const p2 = (n) => String(n).padStart(2, '0');
      const Y = j.getUTCFullYear(), M = p2(j.getUTCMonth() + 1), D = p2(j.getUTCDate()), H = j.getUTCHours();
      const ymd = '' + Y + M + D;
      const id = ymd + p2(H);
      await db.collection('envLog').doc(id).set({
        ts: admin.firestore.FieldValue.serverTimestamp(),
        temperature: (indoorFresh && typeof e.temperature === 'number') ? e.temperature : null,
        humidity: (indoorFresh && typeof e.humidity === 'number') ? e.humidity : null,
        outdoorTemperature: out.t,
        outdoorHumidity: out.h,
        date: ymd, ym: '' + Y + M, hour: H
      }, { merge: true });
      return null;
    } catch (err) {
      console.error('logEnvHourly error:', err);
      return null;
    }
  });

// ── カレンダーHTMLをサイトリポジトリへ公開（owner専用・GitHubトークンはFirestoreに保存） ──
// ブラウザにトークンを保存しないため、都度の再入力が不要になる（初回のみ入力）。
exports.publishCalendar = functions.region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', '認証が必要です');
    // owner判定（claim または members.role）
    let isOwner = context.auth.token && context.auth.token.role === 'owner';
    if (!isOwner) {
      const cs = await db.collection('members').where('authUid', '==', context.auth.uid).limit(1).get();
      isOwner = !cs.empty && cs.docs[0].data().role === 'owner';
    }
    if (!isOwner) throw new functions.https.HttpsError('permission-denied', 'オーナー権限が必要です');

    const files = Array.isArray(data && data.files) ? data.files : [];
    if (!files.length) throw new functions.https.HttpsError('invalid-argument', 'ファイルがありません');
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
        throw new functions.https.HttpsError('invalid-argument', 'ファイル形式が不正です');
      }
      if (!/^calendar\/[A-Za-z0-9_.\-]+\.html$/.test(f.path)) {
        throw new functions.https.HttpsError('invalid-argument', 'パスが不正です: ' + f.path);
      }
      if (f.content.length > 800000) {
        throw new functions.https.HttpsError('invalid-argument', 'ファイルが大きすぎます: ' + f.path);
      }
    }

    const cfgRef = db.collection('appConfig').doc('github');
    let token = (data && typeof data.token === 'string' && data.token.trim()) ? data.token.trim() : '';
    if (token) {
      await cfgRef.set({ calToken: token, calTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } else {
      const snap = await cfgRef.get();
      token = (snap.exists && snap.data().calToken) || '';
    }
    if (!token) throw new functions.https.HttpsError('failed-precondition', 'GitHubトークンが未設定です。初回のみトークンを入力してください。');

    const owner = 'teqmae23', repo = 'tequiladojo-site', branch = 'main';
    const results = [];
    for (const f of files) {
      const url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + f.path;
      const headers = {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'tequiladojo-calendar'
      };
      let sha = null;
      const getRes = await fetch(url + '?ref=' + encodeURIComponent(branch), { headers });
      if (getRes.status === 401) throw new functions.https.HttpsError('unauthenticated', 'GitHubトークンが無効です。トークンを入力し直してください。');
      if (getRes.ok) { const j = await getRes.json(); sha = (j && j.sha) || null; }
      const body = { message: 'Update ' + f.path, content: Buffer.from(f.content, 'utf8').toString('base64'), branch };
      if (sha) body.sha = sha;
      const putRes = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (putRes.status === 401) throw new functions.https.HttpsError('unauthenticated', 'GitHubトークンが無効です。トークンを入力し直してください。');
      if (!putRes.ok) {
        const t = await putRes.text();
        throw new functions.https.HttpsError('internal', 'GitHub API error (' + f.path + '): ' + putRes.status + ' ' + t.slice(0, 200));
      }
      results.push({ path: f.path, ok: true });
    }
    return { ok: true, files: results };
  });
