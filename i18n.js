/* i18n.js — 公開ページの多言語化（日本語/英語/スペイン語）
 * 判定順: ?lang= → localStorage(td_lang) → navigator.languages → 既定(en)
 * 使い方:
 *   - 静的テキスト: 要素に data-i18n="key"（textContent）/ data-i18n-html="key"（innerHTML）
 *   - 画像: <img data-i18n-src="route-map"> → ja=route-map.png / en=route-map-en.png / es=route-map-es.png
 *   - JS内文言: window.t('key')
 *   言語切替UIは自動で右上に挿入（#lang-switch があればその中に描画）。
 */
(function(){
  var LANGS=['ja','en','es'];
  var DEFAULT='en';

  var DICT={
    ja:{
      switch_label:'言語', lang_ja:'日本語', lang_en:'English', lang_es:'Español',
      nav_about:'テキーラ<br>道場とは？', nav_list:'テキーラ<br>リスト',
      nav_construction:'🚧 工事中', nav_member:'会員<br>ページ',
      nav_register:'新規登録', nav_access:'アクセス',
      news_title:'📢 ニュース', schedule_title:'📅 営業スケジュール（直近7日間）',
      rsv_btn:'🗓 来場予約はこちら',
      rsv_note:'※ 来場予約には会員登録が必要です（スタッフ承認後に確定します）',
      access_title:'📍 アクセス', route_title:'路線案内',
      tokusho:'特定商取引法に基づく表記',
      access_address:'<strong>テキーラ道場</strong>\n        〒260-0854 千葉県千葉市中央区長洲1-24-1<br>\n        エスカイア本千葉第一 2階 214号室<br>\n        <span style="font-size:13px;color:#1a5e3a;font-weight:700;">🚶 JR本千葉駅 徒歩30秒</span>',
      ss_open:'営業中', ss_closed:'閉店中', ss_break:'休憩中', ss_checking:'確認中...',
      ss_visitors:'来店：', ss_people:'人',
      ss_next:'次回：', ss_next_unknown:'次回未定', ss_resume:'再開予定', ss_today:'本日',
      ss_wdays:['日','月','火','水','木','金','土']
    },
    en:{
      switch_label:'Language', lang_ja:'日本語', lang_en:'English', lang_es:'Español',
      nav_about:'What is<br>Tequila Dojo?', nav_list:'Tequila<br>List',
      nav_construction:'🚧 Coming soon', nav_member:'Member<br>Page',
      nav_register:'Sign up', nav_access:'Access',
      news_title:'📢 News', schedule_title:'📅 Business Hours (Next 7 days)',
      rsv_btn:'🗓 Make a Reservation',
      rsv_note:'* Membership is required to reserve (confirmed after staff approval).',
      access_title:'📍 Access', route_title:'Directions',
      tokusho:'Legal Notice (Specified Commercial Transactions Act)',
      access_address:'<strong>Tequila Dojo</strong>\n        Esquire Hon-Chiba Daiichi 2F, Room 214<br>\n        1-24-1 Nagasu, Chuo-ku, Chiba City, Chiba 260-0854<br>\n        <span style="font-size:13px;color:#1a5e3a;font-weight:700;">🚶 30 sec walk from JR Hon-Chiba Sta.</span>',
      ss_open:'Open', ss_closed:'Closed', ss_break:'On break', ss_checking:'Checking...',
      ss_visitors:'Guests: ', ss_people:'',
      ss_next:'Next: ', ss_next_unknown:'Next date TBD', ss_resume:' resume', ss_today:'Today',
      ss_wdays:['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    },
    es:{
      switch_label:'Idioma', lang_ja:'日本語', lang_en:'English', lang_es:'Español',
      nav_about:'¿Qué es<br>Tequila Dojo?', nav_list:'Lista de<br>Tequila',
      nav_construction:'🚧 En construcción', nav_member:'Página de<br>socios',
      nav_register:'Registrarse', nav_access:'Cómo llegar',
      news_title:'📢 Noticias', schedule_title:'📅 Horario (próximos 7 días)',
      rsv_btn:'🗓 Reservar visita',
      rsv_note:'* Se requiere ser socio para reservar (se confirma tras la aprobación del personal).',
      access_title:'📍 Cómo llegar', route_title:'Cómo llegar',
      tokusho:'Aviso legal (Ley de Transacciones Comerciales Especificadas)',
      access_address:'<strong>Tequila Dojo</strong>\n        Esquire Hon-Chiba Daiichi 2F, Sala 214<br>\n        1-24-1 Nagasu, Chuo-ku, Ciudad de Chiba, Chiba 260-0854<br>\n        <span style="font-size:13px;color:#1a5e3a;font-weight:700;">🚶 A 30 seg. a pie de la estación JR Hon-Chiba</span>',
      ss_open:'Abierto', ss_closed:'Cerrado', ss_break:'En descanso', ss_checking:'Comprobando...',
      ss_visitors:'Clientes: ', ss_people:'',
      ss_next:'Próximo: ', ss_next_unknown:'Próxima fecha por confirmar', ss_resume:' reanuda', ss_today:'Hoy',
      ss_wdays:['Dom','Lun','Mar','Mié','Jue','Vie','Sáb']
    }
  };

  function resolveLang(){
    try{ var u=new URLSearchParams(location.search).get('lang'); if(u && LANGS.indexOf(u)>=0) return u; }catch(e){}
    try{ var s=localStorage.getItem('td_lang'); if(s && LANGS.indexOf(s)>=0) return s; }catch(e){}
    var navs=(navigator.languages && navigator.languages.length)?navigator.languages:[navigator.language||''];
    for(var i=0;i<navs.length;i++){
      var l=(navs[i]||'').toLowerCase();
      if(l.indexOf('ja')===0) return 'ja';
      if(l.indexOf('es')===0) return 'es';
      if(l.indexOf('en')===0) return 'en';
    }
    return DEFAULT;
  }

  var current=resolveLang();

  function t(key){
    var d=DICT[current]||DICT.ja;
    if(d[key]!=null) return d[key];
    return (DICT.ja[key]!=null)?DICT.ja[key]:key;
  }

  function apply(){
    document.documentElement.lang=current;
    var d=DICT[current]||DICT.ja;
    var els=document.querySelectorAll('[data-i18n]');
    for(var i=0;i<els.length;i++){ var k=els[i].getAttribute('data-i18n'); if(d[k]!=null) els[i].textContent=d[k]; }
    var elh=document.querySelectorAll('[data-i18n-html]');
    for(var j=0;j<elh.length;j++){ var kh=elh[j].getAttribute('data-i18n-html'); if(d[kh]!=null) elh[j].innerHTML=d[kh]; }
    var imgs=document.querySelectorAll('[data-i18n-src]');
    for(var m=0;m<imgs.length;m++){
      (function(img){
        var base=img.getAttribute('data-i18n-src');
        var src=(current==='ja')?(base+'.png'):(base+'-'+current+'.png');
        img.onerror=function(){ img.onerror=null; img.src=base+'.png'; }; // 言語版が無ければ日本語版へ
        img.src=src;
      })(imgs[m]);
    }
    var elp=document.querySelectorAll('[data-i18n-ph]');
    for(var q=0;q<elp.length;q++){ var kp=elp[q].getAttribute('data-i18n-ph'); if(d[kp]!=null) elp[q].setAttribute('placeholder', d[kp]); }
    var btns=document.querySelectorAll('[data-lang-btn]');
    for(var b=0;b<btns.length;b++){ btns[b].classList.toggle('active', btns[b].getAttribute('data-lang-btn')===current); }
    if(typeof window.onI18nApplied==='function'){ try{ window.onI18nApplied(current); }catch(e){} }
  }

  function setLang(l){
    if(LANGS.indexOf(l)<0) return;
    current=l;
    try{ localStorage.setItem('td_lang', l); }catch(e){}
    apply();
  }

  function injectSwitcher(){
    if(document.getElementById('td-lang-switch')) return;
    var host=document.getElementById('lang-switch');
    var fixed=!host;
    var box=document.createElement('div');
    box.id='td-lang-switch';
    box.style.cssText=fixed
      ? 'position:fixed;top:8px;right:8px;z-index:9999;display:flex;gap:2px;background:rgba(24,17,10,.72);backdrop-filter:blur(4px);border-radius:16px;padding:3px;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      : 'display:inline-flex;gap:2px;align-items:center;vertical-align:middle;';
    LANGS.forEach(function(l){
      var btn=document.createElement('button');
      btn.type='button';
      btn.setAttribute('data-lang-btn', l);
      btn.textContent=(l==='ja')?'日本語':(l==='en')?'EN':'ES';
      // fixed（ページ本文の上に浮かせる）は明るい文字色。ホスト（ヘッダー内に挿入）は
      // 設置先のヘッダー文字色を継承（inherit）するので暗色ヘッダーでも読める。
      btn.style.cssText='border:none;background:transparent;color:'+(fixed?'#f0e6d0':'inherit')+';font-size:11px;font-weight:600;padding:4px 9px;border-radius:13px;cursor:pointer;font-family:inherit;line-height:1;';
      btn.addEventListener('click',function(){ setLang(l); });
      box.appendChild(btn);
    });
    var style=document.createElement('style');
    // アクティブ言語は金色のピル。fixed/ホストのどちらでも暗色背景の上で読める。
    style.textContent='#td-lang-switch button.active{background:#c8921e;color:#1a1200;}';
    document.head.appendChild(style);
    (host||document.body).appendChild(box);
  }

  function init(){ injectSwitcher(); apply(); }

  // ページ固有の辞書を登録（各公開ページが自分の文言を追加できる。i18n.js本体を編集しない）
  function extend(dict){
    if(!dict) return;
    LANGS.forEach(function(l){
      if(dict[l]){ if(!DICT[l]) DICT[l]={}; for(var k in dict[l]){ if(Object.prototype.hasOwnProperty.call(dict[l],k)) DICT[l][k]=dict[l][k]; } }
    });
    if(document.readyState!=='loading') apply();
  }

  window.I18N={ get lang(){return current;}, t:t, apply:apply, setLang:setLang, extend:extend, LANGS:LANGS };
  window.t=t;

  if(document.readyState!=='loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
