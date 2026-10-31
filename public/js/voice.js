/**
 * 음성 인터페이스 — 채팅 화면용 (진짜 비서 3단계 h트랙)
 *
 * - 음성 입력: MediaRecorder 녹음 → POST /api/voice/transcribe → 전사 텍스트를
 *   기존 send() 경로로 전달 (자동 전송 — 핸즈프리 음성 비서 동작).
 * - 음성 출력: 비서 말풍선에 붙은 재생 버튼 → POST /api/voice/synthesize → 재생.
 * - 오디오는 저장하지 않는다. 녹음 Blob은 전송 후 버려진다.
 *
 * iOS PWA 주의:
 * - MediaRecorder는 iOS Safari 14.5+에서 동작하고, mimeType은 audio/mp4(AAC)만
 *   지원한다. 'audio/webm'을 강제하면 생성 자체가 실패하므로 지원 여부를
 *   먼저 확인하고, mp4 → webm/opus → 기본값 순으로 폴백한다.
 * - 녹음 시작·재생은 반드시 사용자 제스처(버튼 탭) 안에서 일어난다.
 *   (이 파일의 모든 getUserMedia/Audio.play 호출은 클릭 핸들러 안에 있다.)
 * - 무음 스위치가 켜져 있으면 <audio> 재생이 들리지 않을 수 있다 (기기 설정).
 */
(function () {
  'use strict';

  var MAX_SECONDS = 60;
  var $ = function (id) { return document.getElementById(id); };

  // Lucide SVG (stroke=currentColor) — 이모지 금지, 기존 디자인 유지
  var SVG_MIC = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
  var SVG_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  var SVG_SPEAKER = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

  // -------------------------------------------------------------------------
  // 상태
  // -------------------------------------------------------------------------
  var recorder = null;
  var chunks = [];
  var recordTimer = null;
  var recordStartedAt = 0;
  var currentAudio = null; // 재생 중인 Audio (하나만 유지)
  var speakingBtn = null;

  function setMicButtons(recording) {
    ['voiceBtn', 'landingVoiceBtn'].forEach(function (id) {
      var btn = $(id);
      if (!btn) return;
      btn.innerHTML = recording ? SVG_STOP : SVG_MIC;
      btn.classList.toggle('recording', recording);
      btn.title = recording ? '녹음 중지 (최대 60초)' : '음성으로 입력';
      btn.setAttribute('aria-label', recording ? '녹음 중지' : '음성으로 입력');
    });
  }

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'; // iOS
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    return '';
  }

  function flashInputHint(message) {
    var input = $('input');
    if (!input) return;
    var prev = input.placeholder;
    input.placeholder = message;
    input.focus();
    setTimeout(function () { input.placeholder = prev; }, 4000);
  }

  // -------------------------------------------------------------------------
  // 음성 입력
  // -------------------------------------------------------------------------
  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      flashInputHint('이 기기·브라우저에서는 음성 입력이 지원되지 않습니다.');
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      var mimeType = pickMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
      chunks = [];
      recordStartedAt = Date.now();
      recorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        finishRecording();
      };
      recorder.start();
      setMicButtons(true);
      // 60초 상한 — 서버 게이트와 동일
      recordTimer = setTimeout(function () { stopRecording(); }, MAX_SECONDS * 1000);
    } catch (e) {
      flashInputHint('마이크를 사용할 수 없습니다. 권한을 확인해주세요.');
    }
  }

  function stopRecording() {
    if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    setMicButtons(false);
  }

  async function finishRecording() {
    setMicButtons(false);
    var seconds = Math.min(MAX_SECONDS, Math.max(1, Math.round((Date.now() - recordStartedAt) / 1000)));
    var blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/mp4' });
    chunks = [];
    if (!blob || blob.size === 0) {
      flashInputHint('녹음된 내용이 없습니다. 다시 말씀해주세요.');
      return;
    }
    var form = new FormData();
    form.append('audio', blob, 'voice.' + (blob.type.indexOf('mp4') >= 0 ? 'm4a' : 'webm'));
    form.append('durationSeconds', String(seconds));
    try {
      var r = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
      var d = await r.json();
      if (!r.ok || !d.ok) {
        flashInputHint(d.message || '음성 인식에 실패했습니다. 텍스트로 입력해주세요.');
        return;
      }
      if (!d.text) {
        flashInputHint('음성을 인식하지 못했습니다. 다시 말씀해주세요.');
        return;
      }
      deliverTranscript(d.text);
    } catch (e) {
      flashInputHint('음성 인식에 실패했습니다. 텍스트로 입력해주세요.');
    }
  }

  // 전사 텍스트를 기존 채팅 경로로 전달한다 (자동 전송).
  function deliverTranscript(text) {
    var landingInput = $('landingInput');
    var inputBar = $('inputBar');
    var landingVisible = landingInput && inputBar && inputBar.style.display === 'none';
    if (landingVisible) {
      landingInput.value = text;
      var landingSend = $('landingSend');
      if (landingSend) landingSend.click();
      return;
    }
    var input = $('input');
    if (!input) return;
    input.value = text;
    if (typeof window.send === 'function') {
      window.send();
    } else {
      var sendBtn = $('send');
      if (sendBtn) sendBtn.click();
    }
  }

  function toggleRecording() {
    if (recorder && recorder.state === 'recording') stopRecording();
    else startRecording();
  }

  // -------------------------------------------------------------------------
  // 음성 출력 — 비서 말풍선 재생 버튼
  // -------------------------------------------------------------------------
  function stopCurrentAudio() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if (speakingBtn) { speakingBtn.classList.remove('playing'); speakingBtn = null; }
  }

  async function speakBubble(btn, bubble) {
    if (speakingBtn === btn) { stopCurrentAudio(); return; } // 재생 중이면 정지
    stopCurrentAudio();
    var text = (bubble.textContent || '').trim();
    if (!text) return;
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      var r = await fetch('/api/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      if (!r.ok) {
        var d = await r.json().catch(function () { return {}; });
        btn.title = (d && d.message) || '음성 재생에 실패했습니다.';
        return;
      }
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      currentAudio = audio;
      speakingBtn = btn;
      btn.classList.add('playing');
      audio.onended = function () { URL.revokeObjectURL(url); stopCurrentAudio(); };
      audio.onerror = function () { URL.revokeObjectURL(url); stopCurrentAudio(); };
      await audio.play(); // 클릭 핸들러 안에서 호출 — iOS 자동재생 정책 충족
    } catch (e) {
      btn.title = '음성 재생에 실패했습니다.';
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // 새 비서 말풍선이 추가되면 재생 버튼을 붙인다.
  function attachSpeakButtons(root) {
    var bubbles = (root || document).querySelectorAll ? root.querySelectorAll('.msg-group:not(.mine) .bubble') : [];
    bubbles.forEach(function (bubble) {
      if (bubble.dataset.voiceAttached) return;
      bubble.dataset.voiceAttached = '1';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'speak-btn';
      btn.innerHTML = SVG_SPEAKER;
      btn.title = '음성으로 듣기';
      btn.setAttribute('aria-label', '음성으로 듣기');
      btn.addEventListener('click', function () { speakBubble(btn, bubble); });
      bubble.appendChild(btn);
    });
  }

  // -------------------------------------------------------------------------
  // 초기화
  // -------------------------------------------------------------------------
  function init() {
    var supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
    ['voiceBtn', 'landingVoiceBtn'].forEach(function (id) {
      var btn = $(id);
      if (!btn) return;
      btn.innerHTML = SVG_MIC;
      if (!supported) {
        btn.disabled = true;
        btn.title = '이 기기·브라우저에서는 음성 입력이 지원되지 않습니다.';
        return;
      }
      btn.addEventListener('click', toggleRecording);
    });
    var msgs = $('msgs');
    if (msgs) {
      attachSpeakButtons(msgs);
      if (typeof MutationObserver !== 'undefined') {
        var observer = new MutationObserver(function (mutations) {
          mutations.forEach(function (m) {
            m.addedNodes.forEach(function (node) {
              if (node.nodeType === 1) attachSpeakButtons(node);
            });
          });
        });
        observer.observe(msgs, { childList: true, subtree: true });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
