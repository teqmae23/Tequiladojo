/**
 * auth-role.js — テキーラ道場 役割認証
 */
var AuthRole = (function() {

  // ページ読み込み時に画面を隠す
  (function hideOnLoad(){
    var style = document.createElement('style');
    style.id = 'auth-role-hide';
    style.textContent = '#login-screen, #app, #main-screen { visibility: hidden !important; }';
    document.head.appendChild(style);
  })();

  function showScreens(){
    var s = document.getElementById('auth-role-hide');
    if(s) s.remove();
  }

  function showLoginScreen(msg){
    showScreens();
    var ls = document.getElementById('login-screen');
    var app = document.getElementById('app');
    if(ls) ls.style.display = 'flex';
    if(app) app.style.display = 'none';
    if(msg){
      var err = document.getElementById('lerr');
      if(err) err.textContent = msg;
    }
  }

  function showDenied(msg){
    showScreens();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666;padding:20px;text-align:center;">' + (msg||'アクセス権限がありません') + '</div>';
  }

  // roleを取得
  async function getRole(user){
    var db = firebase.firestore();
    // 1. staffRoles/{uid} を直接取得（最も確実）
    try {
      var doc = await db.collection('staffRoles').doc(user.uid).get();
      if(doc.exists && doc.data().role) return doc.data().role;
    } catch(e){}
    // 2. Custom Claims
    try {
      var result = await user.getIdTokenResult(true);
      if(result.claims.role) return result.claims.role;
    } catch(e){}
    // 3. members/{memberId} をauthUidで検索
    try {
      var snap = await db.collection('members').where('authUid','==',user.uid).limit(1).get();
      if(!snap.empty && snap.docs[0].data().role) return snap.docs[0].data().role;
    } catch(e){}
    return null;
  }

  // 注: ロール判定（getRole）が完了するまで画面を表示解禁しない。
  // 冒頭で showScreens() すると、非同期判定の待ち時間にログイン画面が
  // 一瞬見えてしまう（遷移時のちらつき）ため、確定した分岐でのみ解禁する。
  function requireStaff(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      if(!user){
        showScreens();
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      // 会員専用アドレスは拒否
      if(user.email && user.email.indexOf('@tequiladojo.member') >= 0){
        await auth.signOut();
        showDenied('スタッフ専用ページです');
        return;
      }
      var role = null;
      try { role = await getRole(user); } catch(e){}
      if(role === 'owner' || role === 'staff'){
        showScreens();
        onAllowed(user, role);
      } else {
        var msg = role ? 'アクセス権限がありません（role:' + role + '）' : '権限が設定されていません（email:' + user.email + '）';
        await auth.signOut();
        showLoginScreen(msg);
      }
    });
  }

  function requireOwner(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      if(!user){
        showScreens();
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      var role = null;
      try { role = await getRole(user); } catch(e){}
      if(role === 'owner'){
        showScreens();
        onAllowed(user, role);
      } else {
        var msg = 'オーナー権限が必要です（role:' + role + '）';
        await auth.signOut();
        showLoginScreen(msg);
      }
    });
  }

  function requireMember(auth, onAllowed, onSignedOut){
    auth.onAuthStateChanged(async function(user){
      if(!user){
        showScreens();
        if(onSignedOut) onSignedOut();
        else showLoginScreen();
        return;
      }
      showScreens();
      onAllowed(user, null);
    });
  }

  // アクティブセッション取得
  async function getActiveSession(db){
    try{
      // 開店中セッション = closeTime 未設定。閉め忘れ検出は無期限（日付窓なし）。
      // ※ 旧実装は where('status','==','open') だったが、セッションに status を保存していない
      //   （開店中は closeTime:null で表現）ため常に空(null)を返し、深夜注文の時刻ずれ
      //   （openTime未取得で+24が効かない）や来場の絞り込み不全の一因になっていた。
      //   開店中は新規開店できない仕様のため、開店中セッションは必ず最新セッション付近に居る。
      //   最新の数件を新しい順で取得し、最初の未閉店セッションを返す（複合インデックス不要）。
      var snap=await db.collection('sessions').orderBy('date','desc').limit(20).get();
      if(snap.empty) return null;
      var list=snap.docs.map(function(d){ var s={id:d.id}; Object.assign(s,d.data()); return s; });
      list.sort(function(a,b){
        var ka=String(a.date||'')+String(a.openTime||'');
        var kb=String(b.date||'')+String(b.openTime||'');
        return kb.localeCompare(ka);
      });
      var ses=null;
      for(var i=0;i<list.length;i++){ if(!list[i].closeTime){ ses=list[i]; break; } } // closeTime未設定(null/空)=開店中
      if(!ses) return null;
      if(!ses.openDate && ses.date) ses.openDate=ses.date; // openDate を date で正規化（呼出側の互換）
      return ses;
    }catch(e){}
    return null;
  }

  // 営業日付計算（深夜営業対応: openTime基準）
  // 注意: openTime は openclose が "HHMMSS" 文字列で保存するため、そこから日付は導出できない。
  //       日付は openDate/date を渡すこと。パース不能時は null を返し呼出側フォールバックに委ねる。
  function businessDate(openTime, openDate){
    if(openDate) return openDate;
    if(!openTime) return null;
    var d=(openTime&&openTime.toDate)?openTime.toDate():new Date(openTime);
    if(!d||isNaN(d.getTime())) return null;
    return String(d.getFullYear()).slice(2).padStart(2,'0')
      +String(d.getMonth()+1).padStart(2,'0')
      +String(d.getDate()).padStart(2,'0');
  }

  // 現在時刻をHHMMSS文字列で返す（日またぎ時は24h+表記）
  function nowBusinessTime(openTime){
    var now=new Date();
    var nowH=now.getHours(), nowM=now.getMinutes(), nowS=now.getSeconds();
    // 日またぎ検出: 開店が午後（12時以降）で現在が午前（12時前）→ 24加算
    if(openTime && openTime.length>=4){
      var openH=parseInt(openTime.slice(0,2))||0;
      if(openH>=12 && nowH<12){ nowH+=24; }
    }
    return String(nowH).padStart(2,'0')
      +String(nowM).padStart(2,'0')
      +String(nowS).padStart(2,'0');
  }

  // HHMMSS → HH:MM 表示用フォーマット
  function formatBusinessTime(t){
    if(!t||t.length<4) return t||'';
    return t.slice(0,2)+':'+t.slice(2,4);
  }

  // HHMMSS → HH:MM 表示（営業日基準・日跨ぎは24:xx/25:xx表記）
  // 深夜(0〜5時台)は+24時間して 24:22 / 25:18 のように表示する。
  // 既に24以降で保存された値(例 "2422")はそのまま。
  function formatBusinessTime24(t){
    t = String(t || '');
    if(t.length < 4) return t || '';
    var h = parseInt(t.slice(0,2),10);
    var mm = t.slice(2,4);
    if(isNaN(h)) return t.slice(0,2)+':'+mm;
    if(h < 6) h += 24;
    return String(h).padStart(2,'0')+':'+mm;
  }

  // 営業日ソート用: HHMM(SS)文字列を分数値へ変換する。
  // 営業時間は日跨ぎするため、深夜(0〜5時台)は翌日扱いで+24時間する。
  // 空文字は末尾へ回すよう大きな値を返す。
  // 例: "2321"→1401, "0022"→1462, "0118"→1518, "2422"(自動+24表記)→1462。
  function businessSortValue(t){
    t=String(t||'');
    if(t.length<2) return 999999;
    var h=parseInt(t.slice(0,2),10);
    if(isNaN(h)) return 999999;
    var m=parseInt(t.slice(2,4),10)||0;
    if(h<6) h+=24;
    return h*60+m;
  }

  // masterMeta: Rev.+最終更新日時をアトミックにインクリメント
  async function bumpMeta(db, name){
    var ref=db.collection('masterMeta').doc(name);
    return db.runTransaction(async function(t){
      var snap=await t.get(ref);
      var rev=snap.exists?(snap.data().rev||0)+1:1;
      t.set(ref,{rev:rev,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      return rev;
    });
  }

  async function getMeta(db, name){
    var snap=await db.collection('masterMeta').doc(name).get();
    return snap.exists?snap.data():null;
  }

  // ボトル名にsuffixを付加して返す
  function bdName(item, lang){
    var base;
    if(lang==='ja') base=item.bottleJaBase||item.bottleJa||item.bottleEsBase||item.bottleEs||item.bottleEn||item.name||item.id||'';
    else base=item.bottleEsBase||item.bottleEs||item.bottleJaBase||item.bottleJa||item.bottleEn||item.name||item.id||'';
    var sfx=(item.suffix||'').trim();
    if(!sfx) return base;
    base=base.replace(new RegExp(' ?\\('+sfx.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\)$'),'');
    return base+' ('+sfx+')';
  }

  // visitが現セッションに属するか判定
  function isVisitInSession(v, session){
    if(!session) return true;
    var sessionDate=session.openDate||session.date||businessDate(session.openTime,null);
    var visitDate=v.visitDate||(v.id?v.id.slice(0,6):'');
    if(!sessionDate||!visitDate) return true;
    if(visitDate!==sessionDate) return false;
    // 同一営業日: openTime以降のvisitのみ（日跨ぎ対応）
    var visitTime=v.visitTime||'';
    if(!visitTime||!session.openTime) return true;
    // openTimeは openclose が "HHMMSS" 文字列で保存する（例 "205930"）。
    // Timestampの可能性もあるため両対応でHHMMを求める。
    // ※ 旧実装は文字列に new Date() を掛けて Invalid Date → NaN となり、
    //   openHHMM が "NaNNaN" になって当日の来場者を全員弾いていた（奢り相手リストが空になる不具合）。
    var openHHMM;
    if(session.openTime.toDate){
      var openTs=session.openTime.toDate();
      openHHMM=String(openTs.getHours()).padStart(2,'0')+String(openTs.getMinutes()).padStart(2,'0');
    } else {
      openHHMM=String(session.openTime).slice(0,4);
    }
    if(!/^\d{4}$/.test(openHHMM)) return true; // openTimeが不正なら除外しない（安全側）
    var vt=visitTime.slice(0,4);
    if(vt>=openHHMM) return true;
    // 日跨ぎ: 開店が午後(12時以降)で来場が午前(0〜11時台)なら翌暦日＝同一営業日として含める
    var openH=parseInt(openHHMM.slice(0,2),10)||0;
    var vH=parseInt(vt.slice(0,2),10)||0;
    if(openH>=12 && vH<12) return true;
    return false;
  }

  // 営業日(YYMMDD)からセッションを取得（同日複数は開店が遅い＝最新を優先）。
  async function getSessionByDate(db, yymmdd){
    if(!yymmdd) return null;
    try{
      var snap=await db.collection('sessions').where('date','==',yymmdd).get();
      if(snap.empty) return null;
      var list=snap.docs.map(function(d){ var s={id:d.id}; Object.assign(s,d.data()); return s; });
      list.sort(function(a,b){ return String(b.openTime||'').localeCompare(String(a.openTime||'')); });
      var s=list[0];
      if(!s.openDate && s.date) s.openDate=s.date;
      return s;
    }catch(e){ return null; }
  }

  // あるセッションに属する来場を全件返す（退場済み＝checkoutTime有りも含む）。
  // 奢り相手/スタッフの選択を「営業中でなくても」そのセッション基準で出すための共通ロジック。
  async function getSessionVisits(db, session){
    try{
      var snap=await db.collection('visits').get();
      var out=[];
      snap.forEach(function(d){
        var v={id:d.id}; Object.assign(v, d.data());
        if(v.hidden===true) return;
        if(isVisitInSession(v, session)) out.push(v);
      });
      return out;
    }catch(e){ return []; }
  }

  return { requireStaff: requireStaff, requireOwner: requireOwner, requireMember: requireMember,
           getActiveSession: getActiveSession, businessDate: businessDate,
           nowBusinessTime: nowBusinessTime, formatBusinessTime: formatBusinessTime,
           formatBusinessTime24: formatBusinessTime24,
           businessSortValue: businessSortValue,
           isVisitInSession: isVisitInSession, bdName: bdName,
           getSessionByDate: getSessionByDate, getSessionVisits: getSessionVisits,
           bumpMeta: bumpMeta, getMeta: getMeta };
})();
