// blind-result.js — ブラインド結果入力モジュール
// Usage: BlindResult.init({db, getBlindMarks, getVisits, vLabel, showToast, markSym, esc, onSaved, injectUI})
//        BlindResult.open(batchGroup, lockedVisitKey?)  — open the result modal
//        BlindResult.loadExisting()                     — load saved answers from Firestore

var BlindResult = (function(){
  'use strict';

  var _db, _getBlindMarks, _getVisits, _vLabel, _showToast, _markSym, _esc, _onSaved, _onClose;
  var _canEdit = true;
  var _state = null;
  var _panel = null;

  // ── CSS injected into <head> ──
  var _CSS = [
    '.result-info{padding:10px 16px;background:var(--cream);font-size:13px;color:var(--ink2);border-bottom:1px solid var(--border)}',
    '.blind-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}',
    '.blind-table{border-collapse:collapse;width:100%;font-size:12px}',
    '.blind-table th,.blind-table td{border:1px solid var(--border2);padding:3px 2px;text-align:center;white-space:nowrap}',
    '.blind-table th{background:var(--cream2);font-size:10px;font-weight:600;color:var(--ink3)}',
    '.blind-table th.mark-head{font-size:12px;padding:3px 2px;min-width:32px}',
    '.blind-table td.name-cell{text-align:left;font-weight:600;font-size:12px;color:var(--ink);background:var(--cream);padding-left:8px;padding-right:6px;min-width:60px;max-width:90px;overflow:hidden;text-overflow:ellipsis}',
    '.blind-table td.mark-cell{padding:2px;min-width:32px;width:32px}',
    '.blind-table td.winner-cell{padding:2px;min-width:32px;width:32px}',
    '.blind-table td.score-cell{font-family:var(--mono);font-weight:700;color:var(--gold-d);min-width:36px;font-size:11px}',
    '.blind-table td.correct{background:#d4edda}',
    '.blind-table td.wrong{background:#f8d7da}',
    '.mark-legend{padding:8px 16px;background:var(--cream);border-top:1px solid var(--border)}',
    '.mark-legend-title{font-size:10px;font-weight:600;color:var(--ink3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}',
    '.mark-legend-row{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px}',
    '.mark-legend-dot{font-size:13px;min-width:22px;text-align:center}',
    '.mark-legend-name{color:var(--ink2)}',
    '.result-action-bar{padding:10px 16px;display:flex;gap:8px;border-top:1px solid var(--border);background:var(--cream2)}',
    '.tbl-mark-picker{position:relative;display:inline-block}',
    '.tbl-mark-btn{display:inline-flex;align-items:center;gap:1px;padding:2px 3px;background:var(--cream);border:1px solid var(--border2);border-radius:4px;cursor:pointer;min-width:28px;width:28px;justify-content:center;user-select:none;transition:border-color .15s}',
    '.tbl-mark-btn:hover{border-color:var(--gold)}',
    '.tbl-mark-btn.selected{border-color:var(--gold-d);background:var(--cream2)}',
    '.tbl-mark-caret{font-size:7px;color:var(--ink3);flex-shrink:0}',
    '.tbl-mark-panel{display:none;position:fixed;background:var(--white);border:1px solid var(--border2);border-radius:var(--r);box-shadow:var(--shadow-lg);z-index:9999;padding:3px;min-width:36px}',
    '.tbl-mark-panel.open{display:block}',
    '.tbl-mark-opt{display:flex;align-items:center;justify-content:center;padding:3px 4px;border-radius:3px;cursor:pointer;font-size:13px;transition:background .1s}',
    '.tbl-mark-opt:hover{background:var(--cream2)}',
    '.tbl-mark-opt.active{background:var(--cream3)}',
    '.tbl-mark-none{font-size:10px;color:var(--ink3);text-align:center;padding:4px 3px;cursor:pointer;border-radius:3px}',
    '.tbl-mark-none:hover{background:var(--cream2)}'
  ].join('\n');

  // ── HTML injected into <body> ──
  var _HTML = '<div class="modal-overlay" id="result-modal">'
    + '<div class="modal-panel" style="max-width:680px">'
    + '<div class="modal-header">'
    + '<span class="modal-title" id="result-modal-title">🎭 ブラインド結果入力</span>'
    + '<button class="btn bs sm" onclick="BlindResult.close()">✕ 閉じる</button>'
    + '</div>'
    + '<div id="result-body"></div>'
    + '<div class="result-action-bar" id="result-action-input">'
    + '<button class="btn bs" id="btn-show-result" onclick="BlindResult.show()" style="flex:1">結果を見る</button>'
    + '<button class="btn bs" id="btn-confirm-partial" onclick="BlindResult.confirmPartial()" style="flex:1">未入力のまま確定</button>'
    + '<button class="btn bp" id="btn-save-result-hidden" style="flex:1" disabled>結果を保存する</button>'
    + '</div>'
    + '<div class="result-action-bar" id="result-action-revealed" style="display:none">'
    + '<button class="btn bs" id="btn-back-to-input" onclick="BlindResult.backToInput()" style="flex:1">← 入力に戻る</button>'
    + '<button class="btn bs" id="btn-confirm-partial-r" onclick="BlindResult.confirmPartial()" style="flex:1;display:none">未入力のまま確定</button>'
    + '<button class="btn bp" id="btn-save-result" onclick="BlindResult.save()" style="flex:1" disabled>結果を保存する</button>'
    + '</div>'
    + '</div>'
    + '</div>';

  // ── Public: init ──
  function init(cfg){
    _db = cfg.db;
    _getBlindMarks = cfg.getBlindMarks;
    _getVisits = cfg.getVisits;
    _vLabel = cfg.vLabel;
    _showToast = cfg.showToast;
    _markSym = cfg.markSym;
    _esc = cfg.esc || function(s){
      if(!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    };
    _onSaved = cfg.onSaved || null;
    _onClose = cfg.onClose || null;
    _canEdit = (cfg.canEdit !== false);
    if(cfg.injectUI !== false) _injectUI();
  }

  function _injectUI(){
    if(document.getElementById('result-modal')) return;
    var style = document.createElement('style');
    style.textContent = _CSS;
    document.head.appendChild(style);
    var wrap = document.createElement('div');
    wrap.innerHTML = _HTML;
    document.body.appendChild(wrap.firstElementChild);
    document.addEventListener('click', _closePanel);
  }

  function _g(id){ return document.getElementById(id); }

  // ── Panel (floating mark picker) ──
  function _closePanel(){
    if(_panel){ _panel.remove(); _panel = null; }
  }

  function _buildPicker(mi, mki, chosenMarkId){
    var blindMarks = _getBlindMarks();
    var pid = 'tp-' + mi + '-' + mki;
    var btnInner = '<span style="font-size:9px;color:var(--ink3)">選択</span>';
    if(chosenMarkId){
      var ms = _markSym(blindMarks.find(function(m){ return m.id === chosenMarkId; }) || {id: chosenMarkId});
      btnInner = '<span style="color:' + ms.color + ';font-weight:700;font-size:12px;letter-spacing:-1px;line-height:1">' + ms.sym + '</span>';
    }
    return '<div class="tbl-mark-picker">'
      + '<div class="tbl-mark-btn' + (chosenMarkId ? ' selected' : '') + '" id="' + pid + '-btn"'
      + ' onclick="event.stopPropagation();BlindResult._openPicker(\'' + pid + '\',' + mi + ',' + mki + ',this)">'
      + btnInner + '<span class="tbl-mark-caret">▾</span>'
      + '</div>'
      + '</div>';
  }

  function _buildWinnerPicker(mi, chosenMarkId){
    var blindMarks = _getBlindMarks();
    var pid = 'tw-' + mi;
    var btnInner = '<span style="font-size:9px;color:var(--ink3)">好き</span>';
    if(chosenMarkId){
      var ms = _markSym(blindMarks.find(function(m){ return m.id === chosenMarkId; }) || {id: chosenMarkId});
      btnInner = '<span style="color:' + ms.color + ';font-weight:700;font-size:12px;letter-spacing:-1px;line-height:1">' + ms.sym + '</span>';
    }
    return '<div class="tbl-mark-picker">'
      + '<div class="tbl-mark-btn' + (chosenMarkId ? ' selected' : '') + '" id="' + pid + '-btn"'
      + ' onclick="event.stopPropagation();BlindResult._openWinnerPicker(\'' + pid + '\',' + mi + ',this)">'
      + btnInner + '<span class="tbl-mark-caret">▾</span>'
      + '</div>'
      + '</div>';
  }

  // ── Public: picker openers (called from inline onclick) ──
  function _openPicker(pid, mi, mki, btnEl){
    _closePanel();
    var blindMarks = _getBlindMarks();
    var marks = _state.marks;
    var answers = _state.answers;
    var chosenMarkId = answers[mi][mki];
    var usedMarks = new Set(answers[mi].filter(function(m, i){ return i !== mki && m; }));

    var makeOpt = function(m, isUsed){
      var ms = _markSym(blindMarks.find(function(x){ return x.id === m; }) || {id: m});
      var activeCls = chosenMarkId === m ? ' active' : '';
      var usedStyle = isUsed ? 'opacity:.55;' : '';
      return '<div class="tbl-mark-opt' + activeCls + '" style="' + usedStyle + '"'
        + ' onclick="event.stopPropagation();BlindResult._setAnswer(' + mi + ',' + mki + ',\'' + _esc(m) + '\')">'
        + '<span style="color:' + ms.color + ';font-weight:700;font-size:12px;letter-spacing:-1px;line-height:1">' + ms.sym + '</span>'
        + '</div>';
    };

    var freeMarks = marks.filter(function(m){ return !usedMarks.has(m); });
    var usedMarksList = marks.filter(function(m){ return usedMarks.has(m); });
    var freeOpts = freeMarks.map(function(m){ return makeOpt(m, false); }).join('');
    var usedOpts = usedMarksList.length
      ? '<div style="border-top:1px solid var(--border2);margin:2px 0"></div>'
        + usedMarksList.map(function(m){ return makeOpt(m, true); }).join('')
      : '';

    var panel = document.createElement('div');
    panel.className = 'tbl-mark-panel open';
    panel.id = pid + '-panel';
    panel.innerHTML = '<div class="tbl-mark-none" onclick="event.stopPropagation();BlindResult._setAnswer(' + mi + ',' + mki + ',\'\')">−</div>' + freeOpts + usedOpts;
    panel.addEventListener('click', function(e){ e.stopPropagation(); });
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    _panel = panel;
    requestAnimationFrame(function(){
      var rect = btnEl.getBoundingClientRect();
      var ph = panel.offsetHeight;
      var spaceBelow = window.innerHeight - rect.bottom - 8;
      panel.style.top = (spaceBelow < ph && rect.top > ph ? rect.top - ph - 4 : rect.bottom + 4) + 'px';
      panel.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 4)) + 'px';
      panel.style.visibility = 'visible';
    });
  }

  function _openWinnerPicker(pid, mi, btnEl){
    _closePanel();
    var blindMarks = _getBlindMarks();
    var marks = _state.marks;
    var chosenMarkId = _state.winners[mi];
    var opts = marks.map(function(m){
      var ms = _markSym(blindMarks.find(function(x){ return x.id === m; }) || {id: m});
      return '<div class="tbl-mark-opt' + (chosenMarkId === m ? ' active' : '') + '"'
        + ' onclick="event.stopPropagation();BlindResult._setWinner(' + mi + ',\'' + _esc(m) + '\')">'
        + '<span style="color:' + ms.color + ';font-weight:700;font-size:12px;letter-spacing:-1px;line-height:1">' + ms.sym + '</span>'
        + '</div>';
    }).join('');
    var panel = document.createElement('div');
    panel.className = 'tbl-mark-panel open';
    panel.innerHTML = '<div class="tbl-mark-none" onclick="event.stopPropagation();BlindResult._setWinner(' + mi + ',\'\')">−</div>' + opts;
    panel.addEventListener('click', function(e){ e.stopPropagation(); });
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    _panel = panel;
    requestAnimationFrame(function(){
      var rect = btnEl.getBoundingClientRect();
      var ph = panel.offsetHeight;
      var spaceBelow = window.innerHeight - rect.bottom - 8;
      panel.style.top = (spaceBelow < ph && rect.top > ph ? rect.top - ph - 4 : rect.bottom + 4) + 'px';
      panel.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 4)) + 'px';
      panel.style.visibility = 'visible';
    });
  }

  // 店側の編集を blindGuesses に反映（会員のリアルタイム表へ即共有するため・追加のみ）。
  // 実バッチ(batchId)のみ対象。confirmed 等は触れず answers/winner を merge。
  function _persistRowGuess(mi, confirmed){
    if(!_db || !_state || !_state.b || !_state.b.batchId) return;
    var bid = _state.b.batchId;
    var g = _state.members[mi]; if(!g) return;
    var visit = _getVisits().find(function(v){ return v.id === g.visitKey; });
    var customerId = (visit && visit.memberId) || g.visitKey;
    if(!customerId) return;
    var answers = _state.marks.map(function(mk, mki){ return {blindMarkId: mk, guessMarkId: _state.answers[mi][mki] || null}; });
    var data = {
      id: bid + '__' + customerId, batchId: bid, groupId: g.gid,
      visitKey: g.visitKey, customerId: customerId, name: _vLabel(g.visitKey),
      answers: answers, winner: _state.winners[mi] || null,
      source: 'staff', updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if(confirmed === true){ data.confirmed = true; data.confirmedAt = firebase.firestore.FieldValue.serverTimestamp(); }
    _db.collection('blindGuesses').doc(data.id).set(data, {merge:true}).catch(function(){});
  }

  // スタッフ参加者の行か（会員入力許可中は、会員行は「?」＋入力不可、スタッフ行のみ入力可）
  function _isStaffRow(g){
    if(!g) return false;
    var v = _getVisits().find(function(x){ return x.id === g.visitKey; });
    if(v && v.isStaff) return true;
    return (g.orders || []).some(function(o){ return o.isBlindStaff; });
  }
  // 会員入力を許可した状態での全員表（スタッフ結果入力画面）か
  function _staffInputMode(){ return !!(_state && _state.inputOpen && !_state.lockedVisitKey); }
  // スタッフ参加者の入力を確定（自分の結果の確定ボタン）
  function confirmStaffInput(){
    if(!_state) return;
    var n = 0;
    _state.members.forEach(function(g, mi){ if(_isStaffRow(g)){ _persistRowGuess(mi, true); n++; } });
    _showToast(n ? 'スタッフの入力を確定しました' : 'スタッフ参加者がいません', n ? 'success' : 'error');
  }

  // ── Public: answer/winner setters (called from inline onclick) ──
  function _setAnswer(mi, mki, markId){
    _closePanel();
    if(!markId){
      _state.answers[mi][mki] = null;
      _renderTable();
      _persistRowGuess(mi);
      return;
    }
    var existIdx = _state.answers[mi].findIndex(function(m, i){ return i !== mki && m === markId; });
    if(existIdx >= 0){
      _state.answers[mi][existIdx] = _state.answers[mi][mki] || null;
    }
    _state.answers[mi][mki] = markId;
    _renderTable();
    _persistRowGuess(mi);
  }

  function _setWinner(mi, markId){
    _closePanel();
    _state.winners[mi] = markId || null;
    _renderTable();
    _persistRowGuess(mi);
  }

  // ── Private: title + switch helpers ──
  function _updateTitle(){
    var s = _state;
    var title = _g('result-modal-title');
    if(!s.revealed || s.revealed === 'partial'){
      title.textContent = '🎭 ブラインド結果入力';
      return;
    }
    var allFilled = s.allConfirmed || (
      s.members.every(function(_, mi){ return s.marks.every(function(_, mki){ return !!s.answers[mi][mki]; }); })
      && s.members.every(function(_, mi){ return !!s.winners[mi]; })
    );
    title.textContent = allFilled
      ? '🎭 ブラインド結果表示（最終結果）'
      : '🎭 ブラインド結果表示（途中経過）';
  }

  function _switchToRevealed(allConfirmed){
    _g('result-action-input').style.display = 'none';
    _g('result-action-revealed').style.display = 'flex';
    var backBtn = _g('btn-back-to-input');
    if(backBtn) backBtn.style.display = _canEdit ? '' : 'none';
    var s = _state;
    var hasEmpty = s.members.some(function(_, mi){
      return s.marks.some(function(_, mki){ return !s.answers[mi][mki]; });
    });
    var saveBtn = _g('btn-save-result');
    var partialBtn = _g('btn-confirm-partial-r');
    if(!_canEdit){
      saveBtn.style.display = 'none';
      partialBtn.style.display = 'none';
    } else if(hasEmpty && !allConfirmed){
      saveBtn.disabled = true;
      partialBtn.style.display = 'flex';
    } else {
      saveBtn.disabled = false;
      partialBtn.style.display = 'none';
    }
    _updateTitle();
  }

  // ── Private: render table ──
  function _renderTable(){
    var s = _state;
    var blindMarks = _getBlindMarks();
    var members = s.members, marks = s.marks, markToOrder = s.markToOrder;
    var answers = s.answers, winners = s.winners, revealed = s.revealed;
    var memberNames = members.map(function(g){ return _vLabel(g.visitKey); });
    var nums = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
    var allConfirmed = s.allConfirmed || false;
    var isRevealed = revealed === true || revealed === 'partial';
    var colAllFilled = marks.map(function(_, mki){
      return (allConfirmed && revealed === true)
        || members.every(function(_, mi){ return !!answers[mi][mki]; });
    });
    var allWinnerFilled = members.every(function(_, mi){ return !!winners[mi]; });
    var winnerCount = {};
    if(revealed === true && allWinnerFilled){
      winners.forEach(function(w){ if(w) winnerCount[w] = (winnerCount[w] || 0) + 1; });
    }

    var thMarks = marks.map(function(m, mi){
      if(isRevealed && colAllFilled[mi]){
        var ms = _markSym(blindMarks.find(function(x){ return x.id === m; }) || {id: m});
        return '<th class="mark-head"><div style="font-size:12px;color:var(--ink3)">' + (nums[mi] || '') + '</div>'
          + '<div style="color:' + ms.color + ';font-weight:700;font-size:12px;letter-spacing:-1px">' + ms.sym + '</div></th>';
      }
      return '<th class="mark-head" style="font-size:13px">' + (nums[mi] || '?') + '</th>';
    }).join('');
    var thead = '<thead><tr>'
      + '<th style="text-align:left;padding-left:10px">名前</th>'
      + thMarks
      + '<th>好</th><th>正解</th>'
      + '</tr></thead>';

    var lockedVk = s.lockedVisitKey || null;
    var staffInputMode = !!s.inputOpen && !lockedVk; // 会員入力許可中の全員表: スタッフ行のみ編集
    var tbody = members.map(function(g, mi){
      // 通常(許可前)は全員編集可。会員入力許可中はスタッフ参加者行のみ編集可（会員行は「?」）。ロック時は該当visitのみ。
      var isMyRow = lockedVk ? (g.visitKey === lockedVk) : (staffInputMode ? _isStaffRow(g) : true);
      var cells = marks.map(function(m, mki){
        var chosen = answers[mi][mki];
        var cellClass = 'mark-cell';
        var cellContent = '';
        if(!isMyRow){
          if(chosen){
            if(isRevealed){
              var ms2 = _markSym(blindMarks.find(function(x){ return x.id === chosen; }) || {id: chosen});
              cellContent = '<span style="color:' + ms2.color + ';font-weight:700;font-size:12px;letter-spacing:-1px">' + ms2.sym + '</span>';
            } else {
              // 公開前は他の参加者の選択マークを「?」で隠す（スタッフ参加時も同様）
              cellContent = '<span style="color:var(--ink3);font-weight:700">?</span>';
            }
          } else {
            cellContent = '<span style="color:var(--ink3)">—</span>';
          }
        } else if(!isRevealed){
          cellContent = _buildPicker(mi, mki, chosen);
        } else if(!colAllFilled[mki]){
          if(chosen){
            var ms3 = _markSym(blindMarks.find(function(x){ return x.id === chosen; }) || {id: chosen});
            cellContent = '<span style="color:' + ms3.color + ';font-weight:700;font-size:12px;letter-spacing:-1px">' + ms3.sym + '</span>';
          } else {
            cellContent = revealed === 'partial'
              ? '<span style="color:var(--ink3)">—</span>'
              : _buildPicker(mi, mki, chosen);
          }
        } else {
          if(chosen){
            var isCorrect = chosen === marks[mki];
            cellClass += isCorrect ? ' correct' : ' wrong';
            var ms4 = _markSym(blindMarks.find(function(x){ return x.id === chosen; }) || {id: chosen});
            cellContent = '<span style="color:' + ms4.color + ';font-weight:700;font-size:12px;letter-spacing:-1px">' + ms4.sym + '</span>';
          } else {
            cellClass += ' wrong';
            cellContent = '<span style="color:var(--ink3)">—</span>';
          }
        }
        return '<td class="' + cellClass + '">' + cellContent + '</td>';
      }).join('');

      var w = winners[mi];
      var winnerCell;
      if(!isMyRow){
        if(w){
          if(isRevealed){
            var msw = _markSym(blindMarks.find(function(x){ return x.id === w; }) || {id: w});
            winnerCell = '<span style="color:' + msw.color + ';font-weight:700;font-size:12px;letter-spacing:-1px">' + msw.sym + '</span>';
          } else {
            winnerCell = '<span style="color:var(--ink3);font-weight:700">?</span>'; // 公開前は他者の[好]も隠す
          }
        } else {
          winnerCell = '<span style="color:var(--ink3)">—</span>';
        }
      } else if(isRevealed && w){
        var msw2 = _markSym(blindMarks.find(function(x){ return x.id === w; }) || {id: w});
        winnerCell = '<span style="color:' + msw2.color + ';font-weight:700;font-size:12px;letter-spacing:-1px">' + msw2.sym + '</span>';
      } else {
        winnerCell = _buildWinnerPicker(mi, w);
      }

      var scoreCell = '—';
      if(isRevealed){
        var filledMkis = marks.map(function(_, mki2){ return mki2; }).filter(function(mki2){ return colAllFilled[mki2]; });
        var correctCount = filledMkis.filter(function(mki2){ return answers[mi][mki2] === marks[mki2]; }).length;
        if(filledMkis.length > 0){
          var sc = correctCount === filledMkis.length ? 'var(--teal)' : 'var(--ink)';
          scoreCell = '<strong style="color:' + sc + '">' + correctCount + '/' + filledMkis.length + '</strong>';
        }
      }

      var winnerLabel = '';
      if(revealed === true && allWinnerFilled && w){
        var wc = members.filter(function(_, i){ return winners[i] === w; }).length;
        winnerLabel = '<span style="font-size:10px;color:var(--ink3);margin-left:4px">好き:' + wc + '</span>';
      }

      var rowStyle = lockedVk ? (isMyRow ? 'background:rgba(200,146,30,.06)' : 'opacity:0.55') : '';
      return '<tr style="' + rowStyle + '">'
        + '<td class="name-cell">' + _esc(memberNames[mi])
        + (lockedVk && !isMyRow ? '<span style="font-size:9px;color:var(--ink3);margin-left:4px">参照</span>' : '')
        + winnerLabel + '</td>'
        + cells
        + '<td class="winner-cell">' + winnerCell + '</td>'
        + '<td class="score-cell">' + scoreCell + '</td>'
        + '</tr>';
    }).join('');

    var legendRows = marks.map(function(m, mi){
      var o = markToOrder[m];
      var ms5 = _markSym(blindMarks.find(function(x){ return x.id === m; }) || {id: m});
      var markSpan = (isRevealed && colAllFilled[mi])
        ? '<span style="color:' + ms5.color + ';font-weight:700;font-size:12px;letter-spacing:-1px;margin-right:4px">' + ms5.sym + '</span>'
        : '<span style="font-size:13px;margin-right:4px;color:var(--ink3)">?</span>';
      var wc2 = winnerCount[m];
      var winnerTag = (revealed === true && allWinnerFilled && wc2)
        ? '<span style="font-size:10px;color:var(--white);background:var(--gold-d);padding:1px 5px;border-radius:3px;margin-left:6px">好き ' + wc2 + '</span>'
        : '';
      return '<div class="mark-legend-row">'
        + '<span class="mark-legend-dot">' + (nums[mi] || '?') + '</span>'
        + markSpan
        + '<span class="mark-legend-name">' + _esc((o && o.productName) || m) + '</span>' + winnerTag
        + '</div>';
    }).join('');

    _g('result-body').innerHTML =
      '<div class="result-info"><strong>'
        + members.map(function(g){ return _esc(_vLabel(g.visitKey)); }).join('・')
        + '</strong>&nbsp;|&nbsp;' + marks.length + '種 × ' + members.length + '名</div>'
      + '<div class="blind-table-wrap"><table class="blind-table">' + thead + '<tbody>' + tbody + '</tbody></table></div>'
      + '<div class="mark-legend"><div class="mark-legend-title">マーク対応表</div>' + legendRows + '</div>';

    if(s.revealed) _updateTitle();
  }

  // ── Public: open modal ──
  function open(batchGroup, lockedVisitKey){
    var b = batchGroup;
    if(!b){ _showToast('バッチが見つかりません', 'error'); return; }
    var members = b.groups.filter(function(g){ return g.isBlind; });
    if(!members.length){ _showToast('ブラインド注文がありません', 'error'); return; }
    var allBlindOrders = members.reduce(function(arr, g){
      return arr.concat(g.orders.filter(function(o){ return o.blindId === 1 && o.served !== 0; }));
    }, []);
    var marks = allBlindOrders.map(function(o){ return o.blindMarkId; }).filter(function(m, i, a){ return m && a.indexOf(m) === i; });
    var markToOrder = {};
    marks.forEach(function(m){ markToOrder[m] = allBlindOrders.find(function(o){ return o.blindMarkId === m; }); });
    _state = {
      b: b, members: members, marks: marks, markToOrder: markToOrder,
      answers: members.map(function(){ return marks.map(function(){ return null; }); }),
      winners: members.map(function(){ return null; }),
      revealed: false, allConfirmed: false,
      lockedVisitKey: lockedVisitKey || null
    };
    _renderTable();
    _g('btn-show-result').disabled = false;
    _g('btn-save-result').disabled = true;
    _g('result-action-input').style.display = 'flex';
    _g('result-action-revealed').style.display = 'none';
    _g('result-modal-title').textContent = '🎭 ブラインド結果入力';
    _g('result-modal').classList.add('open');
  }

  // ── Public: load saved results from Firestore ──
  async function loadExisting(){
    if(!_state) return false;
    var allVisits = _getVisits();
    var members = _state.members, marks = _state.marks;
    var hadData = false;
    for(var mi = 0; mi < members.length; mi++){
      var g = members[mi];
      var visit = allVisits.find(function(v){ return v.id === g.visitKey; });
      var customerId = (visit && visit.memberId) || g.visitKey;
      var docId = g.gid + '_' + customerId;
      try {
        var doc = await _db.collection('blindResults').doc(docId).get();
        if(doc.exists){
          var data = doc.data();
          if(data.answers && Array.isArray(data.answers)){
            data.answers.forEach(function(ans){
              var mki = marks.indexOf(ans.blindMarkId);
              if(mki >= 0 && ans.guessMarkId){
                _state.answers[mi][mki] = ans.guessMarkId;
                hadData = true;
              }
            });
          }
          if(data.winner){ _state.winners[mi] = data.winner; hadData = true; }
        }
      } catch(e) {
        console.warn('blindResults load:', e);
      }
    }
    _renderTable();
    return hadData;
  }

  // ── Public: show results ──
  function show(){
    var s = _state;
    var blindMarks = _getBlindMarks();
    for(var mi = 0; mi < s.members.length; mi++){
      var name = _vLabel(s.members[mi].visitKey);
      var chosen = s.answers[mi].filter(Boolean);
      var dup = chosen.filter(function(m, i){ return chosen.indexOf(m) !== i; }).filter(function(m, i, a){ return a.indexOf(m) === i; });
      if(dup.length > 0){
        var dupSyms = dup.map(function(m){ return _markSym(blindMarks.find(function(x){ return x.id === m; }) || {id: m}).sym; }).join('・');
        alert(name + 'に重複した回答があります（' + dupSyms + '）\n修正してください。');
        return;
      }
    }
    s.revealed = true;
    s.allConfirmed = false;
    _renderTable();
    _switchToRevealed(false);
  }

  // ── Public: confirm with partial (unconfirmed entries) ──
  function confirmPartial(){
    var s = _state;
    var blindMarks = _getBlindMarks();
    for(var mi = 0; mi < s.members.length; mi++){
      var name = _vLabel(s.members[mi].visitKey);
      var chosen = s.answers[mi].filter(Boolean);
      var dup = chosen.filter(function(m, i){ return chosen.indexOf(m) !== i; }).filter(function(m, i, a){ return a.indexOf(m) === i; });
      if(dup.length > 0){
        var dupSyms = dup.map(function(m){ return _markSym(blindMarks.find(function(x){ return x.id === m; }) || {id: m}).sym; }).join('・');
        alert(name + 'に重複した回答があります（' + dupSyms + '）\n修正してください。');
        return;
      }
    }
    s.revealed = true;
    s.allConfirmed = true;
    _renderTable();
    _switchToRevealed(true);
  }

  // ── Public: back to input (fixes bug: was 'partial', must be false so pickers show) ──
  function backToInput(){
    _state.revealed = false;
    _state.allConfirmed = false;
    _renderTable();
    _g('result-action-input').style.display = 'flex';
    _g('result-action-revealed').style.display = 'none';
    _g('result-modal-title').textContent = '🎭 ブラインド結果入力';
  }

  // ── Public: close modal ──
  // fromSave=true suppresses onClose so save's onSaved callback controls post-save behavior
  function close(fromSave){
    _g('result-modal').classList.remove('open');
    var inp = _g('result-action-input');
    var rev = _g('result-action-revealed');
    if(inp) inp.style.display = 'flex';
    if(rev) rev.style.display = 'none';
    if(typeof stopGuessWatch === 'function') stopGuessWatch();
    _state = null;
    if(!fromSave && _onClose) _onClose();
  }

  // ── Public: save results to Firestore ──
  async function save(){
    var s = _state;
    if(!s || !s.revealed) return;
    var allVisits = _getVisits();
    var b = s.b, members = s.members, marks = s.marks, markToOrder = s.markToOrder;
    var answers = s.answers, winners = s.winners;
    var hasEmpty = members.some(function(_, mi){ return marks.some(function(_, mki){ return !answers[mi][mki]; }); });
    if(hasEmpty){
      if(!confirm('未選択の項目がありますが保存しますか？')){
        backToInput();
        return;
      }
    }
    try {
      var fsBatch = _db.batch();
      var _journalQueue = [];
      for(var mi = 0; mi < members.length; mi++){
        var g = members[mi];
        var visit = allVisits.find(function(v){ return v.id === g.visitKey; });
        var ans = marks.map(function(actualMark, mki){
          var guessMark = answers[mi][mki];
          var actualOrder = markToOrder[actualMark];
          var guessOrder = markToOrder[guessMark];
          return {
            blindMarkId: actualMark,
            actualOrderId: (actualOrder && actualOrder.id) || '',
            actualProduct: (actualOrder && actualOrder.productName) || '',
            guessMarkId: guessMark,
            guessOrderId: (guessOrder && guessOrder.id) || '',
            guessProduct: (guessOrder && guessOrder.productName) || '',
            isCorrect: guessMark === actualMark
          };
        });
        var correctCount = ans.filter(function(a){ return a.isCorrect; }).length;
        var customerId = (visit && visit.memberId) || g.visitKey;
        var docId = g.gid + '_' + customerId;
        var bottleIds = marks.map(function(m){ return (markToOrder[m] && markToOrder[m].productCode) || m; }).filter(Boolean);
        var bottleComboKey = bottleIds.slice().sort().join('|');
        var _brData = {
          id: docId, groupId: g.gid, batchId: b.batchId || null,
          visitKey: g.visitKey, customerId: customerId,
          answeredAt: firebase.firestore.FieldValue.serverTimestamp(),
          answers: ans, winner: winners[mi],
          correctCount: correctCount, totalCount: marks.length,
          bottleComboKey: bottleComboKey
        };
        fsBatch.set(_db.collection('blindResults').doc(docId), _brData);
        _journalQueue.push({op:'create', col:'blindResults', id:docId, before:null, after:_brData});
        for(var oi = 0; oi < g.orders.length; oi++){
          var o = g.orders[oi];
          if(o.served !== 0){
            fsBatch.update(_db.collection('orders').doc(o.id), {served: 3});
            _journalQueue.push({op:'update', col:'orders', id:o.id, before:{served:o.served}, after:{served:3}});
          }
        }
      }
      await fsBatch.commit();
      if(typeof writeJournal === 'function'){
        _journalQueue.forEach(function(j){ writeJournal(j.op, j.col, j.id, j.before, j.after); });
      }
      _showToast('結果を保存しました', 'success');
      close(true);
      if(_onSaved) _onSaved();
    } catch(e) {
      _showToast('エラー: ' + e.message, 'error');
    }
  }

  // ═══ part2: 会員の一時回答(blindGuesses)取り込み・公開・確定解除（追加のみ・既存非改変） ═══
  var _guessWatchUnsub = null;
  function _batchId(){ return _state && _state.b ? (_state.b.batchId || _state.b.bid) : null; }

  // blindGuesses（会員がマイページで入力した回答）を店側モーダルの state に取り込む
  async function loadGuesses(){
    if(!_state) return false;
    var bid = _batchId(); if(!bid) return false;
    var allVisits = _getVisits();
    var members = _state.members, marks = _state.marks;
    var hadData = false;
    _state.confirmedByRow = _state.confirmedByRow || [];
    try{
      var snap = await _db.collection('blindGuesses').where('batchId','==',bid).get();
      var byCustomer = {};
      snap.docs.forEach(function(d){ var g=d.data(); if(g && g.customerId) byCustomer[g.customerId]=g; });
      for(var mi=0; mi<members.length; mi++){
        var g = members[mi];
        var visit = allVisits.find(function(v){ return v.id===g.visitKey; });
        var customerId = (visit && visit.memberId) || g.visitKey;
        var gd = byCustomer[customerId];
        _state.confirmedByRow[mi] = !!(gd && gd.confirmed);
        if(gd && Array.isArray(gd.answers)){
          gd.answers.forEach(function(ans){
            var mki = marks.indexOf(ans.blindMarkId);
            if(mki>=0 && ans.guessMarkId){ _state.answers[mi][mki] = ans.guessMarkId; hadData=true; }
          });
          if(gd.winner){ _state.winners[mi] = gd.winner; }
        }
      }
    }catch(e){ if(window.console) console.warn('loadGuesses:', e); }
    try{ var _fl = await _db.collection('blindFlights').doc(bid).get(); _state.inputOpen = !!(_fl.exists && _fl.data().inputOpen); }catch(e){}
    _renderTable();
    _renderGuessStatus();
    return hadData;
  }

  // ユーザー(会員)入力の許可/締切をブロードキャスト。許可するまで会員側に入力ボタンは出ない。
  function setInputOpen(open){
    var bid = _batchId(); if(!bid || !_db) return;
    _db.collection('blindFlights').doc(bid).set({
      batchId: bid, inputOpen: !!open, inputOpenAt: firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true}).then(function(){
      if(_state){ _state.inputOpen = !!open; _renderTable(); _renderGuessStatus(); }
      _showToast(open ? 'ユーザー入力を許可しました' : 'ユーザー入力を締め切りました', 'success');
    }).catch(function(e){ _showToast('更新失敗: '+e.message, 'error'); });
  }

  // 確定状況＋公開/解除の操作パネルを動的生成（既存UIは非改変）
  function _renderGuessStatus(){
    if(!_state) return;
    var panel = _g('bg-status');
    if(!panel){
      var body = _g('result-body'); if(!body || !body.parentNode) return;
      panel = document.createElement('div');
      panel.id = 'bg-status';
      panel.style.cssText = 'padding:8px 16px;border-top:1px dashed var(--border2);background:var(--cream);font-size:12px';
      body.parentNode.insertBefore(panel, body.nextSibling);
    }
    var allVisits = _getVisits();
    var chips = _state.members.map(function(g, mi){
      var confirmed = (_state.confirmedByRow||[])[mi];
      var visit = allVisits.find(function(v){ return v.id===g.visitKey; });
      var customerId = (visit && visit.memberId) || g.visitKey;
      var nm = _vLabel(g.visitKey);
      return '<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;padding:2px 8px;border-radius:12px;background:'+(confirmed?'#d7ecdd':'#eee')+';color:'+(confirmed?'#1a6640':'#888')+'">'
        + (confirmed?'✅':'…') + ' ' + _esc(nm)
        + (confirmed?' <b data-unlock="'+_esc(customerId)+'" style="cursor:pointer;color:#a33">解除</b>':'')
        + '</span>';
    }).join('');
    var inputOpen = !!_state.inputOpen;
    var hasStaffRow = _state.members.some(function(g){ return _isStaffRow(g); });
    // 会員入力許可中は、スタッフ参加者が自分の入力を確定するボタンを画面下に1つ表示
    var staffConfirmBtn = (inputOpen && hasStaffRow)
      ? '<button class="btn bp sm" onclick="BlindResult.confirmStaffInput()" style="width:100%;margin-top:6px">✅ 自分（スタッフ）の入力を確定する</button>'
      : '';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px"><b>会員入力状況</b>'
      + '<button class="btn '+(inputOpen?'bs':'bp')+' sm" onclick="BlindResult.setInputOpen('+(inputOpen?'false':'true')+')" style="margin-left:auto">'+(inputOpen?'🔴 入力を締切':'🟢 ユーザー入力を許可')+'</button>'
      + '<button class="btn bs sm" onclick="BlindResult.reveal()">🎭 結果を公開</button>'
      + '<button class="btn bs sm" onclick="BlindResult.unlockAll()">全員の確定解除</button></div>'
      + (inputOpen?'<div style="color:#1a6640;font-size:11px;margin-bottom:4px">※ 会員参加者は各自のマイページで入力中です（この画面では「?」・入力不可）。スタッフ参加者はこの画面で入力し、下のボタンで確定してください。</div>':'<div style="color:#a37b16;font-size:11px;margin-bottom:4px">※「ユーザー入力を許可」を押すまで、会員のマイページに結果入力ボタンは表示されません</div>')
      + '<div>'+ (chips||'<span style="color:#aaa">参加者なし</span>') +'</div>'
      + staffConfirmBtn;
    Array.prototype.forEach.call(panel.querySelectorAll('[data-unlock]'), function(b){
      b.addEventListener('click', function(){ unlock(this.getAttribute('data-unlock')); });
    });
  }

  function watchGuesses(){
    var bid = _batchId(); if(!bid || !_db) return;
    stopGuessWatch();
    _guessWatchUnsub = _db.collection('blindGuesses').where('batchId','==',bid).onSnapshot(function(){
      if(_state) loadGuesses();
    }, function(){});
  }
  function stopGuessWatch(){ if(_guessWatchUnsub){ try{_guessWatchUnsub();}catch(e){} _guessWatchUnsub=null; } }

  // 結果を公開（blindFlights.revealed を全端末へブロードキャスト）＋ローカルでも結果表示
  function reveal(){
    var bid = _batchId();
    if(bid && _db){
      _db.collection('blindFlights').doc(bid).set({
        batchId: bid, revealed: true, revealedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, {merge:true}).catch(function(e){ _showToast('公開に失敗: '+e.message, 'error'); });
    }
    show();
  }

  // 確定解除（個人）: 会員が再入力できるよう confirmed:false に戻す
  function unlock(customerId){
    var bid = _batchId(); if(!bid || !customerId) return;
    _db.collection('blindGuesses').doc(bid+'__'+customerId).update({
      confirmed:false, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){ _showToast('確定を解除しました', 'success'); }).catch(function(e){ _showToast('解除失敗: '+e.message,'error'); });
  }
  async function unlockAll(){
    var bid = _batchId(); if(!bid) return;
    try{
      var snap = await _db.collection('blindGuesses').where('batchId','==',bid).get();
      var batch = _db.batch(); var n=0;
      snap.docs.forEach(function(d){ if(d.data().confirmed){ batch.update(d.ref, {confirmed:false, updatedAt: firebase.firestore.FieldValue.serverTimestamp()}); n++; } });
      if(n){ await batch.commit(); }
      _showToast(n+'件の確定を解除しました', 'success');
    }catch(e){ _showToast('解除失敗: '+e.message, 'error'); }
  }

  return {
    init: init,
    open: open,
    loadExisting: loadExisting,
    loadGuesses: loadGuesses,
    watchGuesses: watchGuesses,
    stopGuessWatch: stopGuessWatch,
    setInputOpen: setInputOpen,
    confirmStaffInput: confirmStaffInput,
    reveal: reveal,
    unlock: unlock,
    unlockAll: unlockAll,
    show: show,
    backToInput: backToInput,
    confirmPartial: confirmPartial,
    save: save,
    close: close,
    _openPicker: _openPicker,
    _openWinnerPicker: _openWinnerPicker,
    _setAnswer: _setAnswer,
    _setWinner: _setWinner
  };
})();
