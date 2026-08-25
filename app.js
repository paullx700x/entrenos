const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const els = {
  start: $('#startPanel'), send: $('#sendPanel'), receive: $('#receivePanel'), transfer: $('#transferPanel'),
  file: $('#fileInput'), drop: $('#dropzone'), dropTitle: $('#dropTitle'), dropHint: $('#dropHint'), offerArea: $('#offerArea'),
  offerCode: $('#offerCode'), offerQr: $('#offerQr'), offerSize: $('#offerSize'), answerInput: $('#answerInput'),
  offerInput: $('#offerInput'), answerArea: $('#answerArea'), answerCode: $('#answerCode'), answerQr: $('#answerQr'), answerSize: $('#answerSize'),
  state: $('#connectionState'), transferTitle: $('#transferTitle'), transferMeta: $('#transferMeta'), progress: $('#progressBar'),
  progressText: $('#progressText'), bytesText: $('#bytesText'), speedText: $('#speedText'), result: $('#resultArea'), orb: $('#statusOrb'),
  scanner: $('#scannerDialog'), scannerVideo: $('#scannerVideo'), scannerHelp: $('#scannerHelp'), toast: $('#toast')
};

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];
const CHUNK = 64 * 1024;
const MAX_BUFFER = 2 * 1024 * 1024;
const ICE_GATHER_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 25000;

let pc = null;
let channel = null;
let selectedFile = null;
let receiveMeta = null;
let receiveChunks = [];
let receivedBytes = 0;
let sentBytes = 0;
let transferStarted = 0;
let scannerStream = null;
let scanTimer = null;
let connectTimer = null;
let downloadUrl = null;

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function show(panel) {
  [els.start, els.send, els.receive, els.transfer].forEach((x) => x.classList.add('hidden'));
  panel.classList.remove('hidden');
  window.scrollTo({ top: Math.max(0, panel.offsetTop - 20), behavior: 'smooth' });
}

function formatBytes(n = 0) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function base64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64url(input) {
  let s = input.replaceAll('-', '+').replaceAll('_', '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encodeSignal(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in window) {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return `EN1.${base64url(compressed)}`;
  }
  return `EN0.${base64url(raw)}`;
}

async function decodeSignal(code) {
  const trimmed = String(code || '').trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0) throw new Error('Código inválido.');
  const prefix = trimmed.slice(0, dot);
  const bytes = fromBase64url(trimmed.slice(dot + 1));
  let raw = bytes;

  if (prefix === 'EN1') {
    if (!('DecompressionStream' in window)) throw new Error('Seu navegador não consegue descompactar este convite.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (prefix !== 'EN0') {
    throw new Error('Versão de convite não reconhecida.');
  }

  const parsed = JSON.parse(new TextDecoder().decode(raw));
  if (!parsed || !['offer', 'answer'].includes(parsed.type) || typeof parsed.sdp !== 'string') {
    throw new Error('Convite WebRTC inválido.');
  }
  return parsed;
}

async function sha256Blob(blob) {
  if (!crypto?.subtle) throw new Error('SHA-256 não está disponível neste contexto. Use HTTPS.');
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function waitIce(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      peer.removeEventListener('icegatheringstatechange', onState);
      clearTimeout(timer);
      resolve();
    };
    const onState = () => peer.iceGatheringState === 'complete' && finish();
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT);
    peer.addEventListener('icegatheringstatechange', onState);
  });
}

function clearConnectionTimer() {
  clearTimeout(connectTimer);
  connectTimer = null;
}

function armConnectionTimer() {
  clearConnectionTimer();
  connectTimer = setTimeout(() => {
    if (pc && !['connected', 'closed'].includes(pc.connectionState)) {
      els.state.textContent = 'DEMORANDO';
      els.orb.textContent = '!';
      els.transferTitle.textContent = 'A conexão direta não fechou';
      els.transferMeta.textContent = 'Algumas redes/NATs bloqueiam P2P sem um servidor TURN. Tente outra rede ou hotspot.';
    }
  }, CONNECT_TIMEOUT);
}

function makePeer() {
  try { pc?.close(); } catch {}
  clearConnectionTimer();
  pc = new RTCPeerConnection({ iceServers: ICE });

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    els.state.textContent = state.toUpperCase();
    if (state === 'connected') {
      clearConnectionTimer();
      els.orb.textContent = '✓';
      els.transferTitle.textContent = channel?.readyState === 'open' ? 'Canal direto conectado' : 'Conectado ao outro dispositivo';
    } else if (['failed', 'disconnected', 'closed'].includes(state)) {
      els.orb.textContent = '!';
      if (state === 'failed') {
        els.transferTitle.textContent = 'A rede bloqueou a conexão direta';
        els.transferMeta.textContent = 'Sem TURN, redes com NAT restritivo podem impedir o P2P. Nenhum arquivo foi enviado para servidor.';
      }
    }
  };

  pc.ondatachannel = (event) => setupChannel(event.channel, false);
  return pc;
}

function renderQR(el, text) {
  el.innerHTML = '';
  if (!window.QRCode) {
    el.innerHTML = '<small style="color:#111;text-align:center">QR indisponível.<br>Use o código ao lado.</small>';
    return;
  }
  try {
    new QRCode(el, { text, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.L });
  } catch {
    el.innerHTML = '<small style="color:#111;text-align:center">Convite grande demais para QR.<br>Use o código ao lado.</small>';
  }
}

function updateTransfer(done, total) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  els.progress.style.width = `${pct}%`;
  els.progressText.textContent = `${pct.toFixed(1)}%`;
  els.bytesText.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
  const seconds = (performance.now() - transferStarted) / 1000;
  els.speedText.textContent = seconds > 0.25 ? `${formatBytes(done / seconds)}/s` : '—';
}

function setupChannel(ch, isSender) {
  channel = ch;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 512 * 1024;

  channel.onopen = () => {
    clearConnectionTimer();
    show(els.transfer);
    els.state.textContent = 'CONECTADO';
    els.orb.textContent = '✓';
    if (isSender) {
      els.transferTitle.textContent = 'Preparando envio direto…';
      els.transferMeta.textContent = selectedFile ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}` : '';
      sendFile().catch((error) => failTransfer(error));
    } else {
      els.transferTitle.textContent = 'Canal pronto para receber';
      els.transferMeta.textContent = 'Aguardando metadados do arquivo…';
    }
  };

  channel.onclose = () => {
    if (els.state.textContent !== 'CONCLUÍDO') els.state.textContent = 'CANAL FECHADO';
  };
  channel.onerror = () => failTransfer(new Error('Falha no canal P2P.'));
  channel.onmessage = (event) => onMessage(event).catch((error) => failTransfer(error));
}

function failTransfer(error) {
  console.error('[EntreNós]', error);
  els.state.textContent = 'ERRO';
  els.orb.textContent = '!';
  els.transferTitle.textContent = 'A transferência foi interrompida';
  els.transferMeta.textContent = error?.message || 'Erro inesperado.';
  toast(error?.message || 'Falha na transferência');
}

async function waitForBuffer() {
  while (channel && channel.readyState === 'open' && channel.bufferedAmount > MAX_BUFFER) {
    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        channel?.removeEventListener('bufferedamountlow', finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 600);
      channel.addEventListener('bufferedamountlow', finish, { once: true });
    });
  }
}

async function sendFile() {
  if (!selectedFile || !channel || channel.readyState !== 'open') return;
  sentBytes = 0;
  transferStarted = performance.now();
  els.result.classList.add('hidden');

  const hash = await sha256Blob(selectedFile);
  channel.send(JSON.stringify({
    type: 'meta',
    name: selectedFile.name,
    size: selectedFile.size,
    mime: selectedFile.type || 'application/octet-stream',
    sha256: hash
  }));

  els.transferTitle.textContent = 'Enviando direto…';
  for (let offset = 0; offset < selectedFile.size; offset += CHUNK) {
    if (channel.readyState !== 'open') throw new Error('O canal foi fechado durante o envio.');
    await waitForBuffer();
    const buf = await selectedFile.slice(offset, Math.min(offset + CHUNK, selectedFile.size)).arrayBuffer();
    channel.send(buf);
    sentBytes += buf.byteLength;
    updateTransfer(sentBytes, selectedFile.size);
  }

  channel.send(JSON.stringify({ type: 'done', bytes: sentBytes }));
  els.state.textContent = 'CONCLUÍDO';
  els.transferTitle.textContent = 'Arquivo enviado';
  els.result.innerHTML = `<strong>Transferência concluída.</strong><p class="muted">SHA-256: <code>${hash}</code></p>`;
  els.result.classList.remove('hidden');
}

async function onMessage(event) {
  if (typeof event.data === 'string') {
    let msg;
    try { msg = JSON.parse(event.data); } catch { throw new Error('Mensagem de controle inválida.'); }

    if (msg.type === 'meta') {
      if (!Number.isSafeInteger(msg.size) || msg.size < 0 || typeof msg.name !== 'string' || typeof msg.sha256 !== 'string') {
        throw new Error('Metadados do arquivo são inválidos.');
      }
      receiveMeta = msg;
      receiveChunks = [];
      receivedBytes = 0;
      transferStarted = performance.now();
      els.transferTitle.textContent = `Recebendo ${msg.name}`;
      els.transferMeta.textContent = `${formatBytes(msg.size)} · verificação SHA-256 ao final`;
      updateTransfer(0, msg.size);
    } else if (msg.type === 'done') {
      await finishReceive();
    }
    return;
  }

  if (!receiveMeta) throw new Error('Dados chegaram antes dos metadados.');
  const chunk = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
  receiveChunks.push(chunk);
  receivedBytes += chunk.byteLength;
  if (receivedBytes > receiveMeta.size) throw new Error('Recebemos mais bytes do que o arquivo anunciado.');
  updateTransfer(receivedBytes, receiveMeta.size);
}

async function finishReceive() {
  if (!receiveMeta) throw new Error('Metadados do arquivo não encontrados.');
  if (receivedBytes !== receiveMeta.size) {
    throw new Error(`Arquivo incompleto: ${formatBytes(receivedBytes)} de ${formatBytes(receiveMeta.size)}.`);
  }

  const blob = new Blob(receiveChunks, { type: receiveMeta.mime || 'application/octet-stream' });
  const hash = await sha256Blob(blob);
  const ok = hash === receiveMeta.sha256;

  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = ok ? URL.createObjectURL(blob) : null;

  els.state.textContent = ok ? 'CONCLUÍDO' : 'DIVERGÊNCIA';
  els.transferTitle.textContent = ok ? 'Arquivo recebido e verificado' : 'Arquivo recebido com divergência';
  els.orb.textContent = ok ? '✓' : '!';
  els.result.innerHTML = `<strong>${ok ? 'Integridade confirmada' : 'Hash não confere'}</strong><p class="muted">${escapeHtml(receiveMeta.name)} · ${formatBytes(blob.size)}<br>SHA-256: <code>${hash}</code></p>${ok ? `<a download="${escapeHtml(receiveMeta.name)}" href="${downloadUrl}">Salvar arquivo</a>` : ''}`;
  els.result.classList.remove('hidden');
  updateTransfer(receiveMeta.size, receiveMeta.size);

  receiveMeta = null;
  receiveChunks = [];
  receivedBytes = 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

async function createOffer() {
  if (!selectedFile) return;
  try {
    const peer = makePeer();
    setupChannel(peer.createDataChannel('entrenos', { ordered: true }), true);
    await peer.setLocalDescription(await peer.createOffer());
    await waitIce(peer);
    const code = await encodeSignal(peer.localDescription.toJSON());
    els.offerCode.value = code;
    els.offerSize.textContent = `${code.length} caracteres`;
    renderQR(els.offerQr, code);
    els.offerArea.classList.remove('hidden');
  } catch (error) {
    toast(error?.message || 'Não foi possível criar o convite.');
  }
}

async function receiveOffer() {
  try {
    const signal = await decodeSignal(els.offerInput.value);
    if (signal.type !== 'offer') throw new Error('Este código não é um convite de envio.');
    const peer = makePeer();
    await peer.setRemoteDescription(signal);
    await peer.setLocalDescription(await peer.createAnswer());
    await waitIce(peer);
    const code = await encodeSignal(peer.localDescription.toJSON());
    els.answerCode.value = code;
    els.answerSize.textContent = `${code.length} caracteres`;
    renderQR(els.answerQr, code);
    els.answerArea.classList.remove('hidden');
    armConnectionTimer();
    toast('Resposta criada');
  } catch (error) {
    toast(error?.message || 'Convite inválido');
  }
}

async function applyAnswer() {
  try {
    if (!pc) throw new Error('Escolha um arquivo e gere o convite primeiro.');
    const signal = await decodeSignal(els.answerInput.value);
    if (signal.type !== 'answer') throw new Error('Este código não é uma resposta WebRTC.');
    await pc.setRemoteDescription(signal);
    show(els.transfer);
    els.state.textContent = 'CONECTANDO';
    els.transferTitle.textContent = 'Estabelecendo canal direto…';
    els.transferMeta.textContent = 'Os bytes só começam a sair quando o DataChannel abrir.';
    armConnectionTimer();
  } catch (error) {
    toast(error?.message || 'Resposta inválida');
  }
}

function reset() {
  closeScanner();
  clearConnectionTimer();
  try { channel?.close(); } catch {}
  try { pc?.close(); } catch {}
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  pc = null;
  channel = null;
  selectedFile = null;
  receiveMeta = null;
  receiveChunks = [];
  receivedBytes = 0;
  sentBytes = 0;
  els.file.value = '';
  els.dropTitle.textContent = 'Toque para escolher um arquivo';
  els.dropHint.textContent = 'ou arraste e solte aqui';
  els.offerArea.classList.add('hidden');
  els.answerArea.classList.add('hidden');
  els.offerInput.value = '';
  els.answerInput.value = '';
  els.result.classList.add('hidden');
  updateTransfer(0, 0);
  show(els.start);
}

function chooseFile(file) {
  if (!file) return;
  selectedFile = file;
  els.dropTitle.textContent = file.name;
  els.dropHint.textContent = `${formatBytes(file.size)} · ${file.type || 'tipo desconhecido'}`;
  createOffer();
}

async function scanInto(target) {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    toast('Leitor de QR indisponível neste navegador');
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    els.scannerVideo.srcObject = scannerStream;
    els.scanner.showModal();
    const loop = async () => {
      try {
        const codes = await detector.detect(els.scannerVideo);
        if (codes[0]?.rawValue) {
          target.value = codes[0].rawValue;
          closeScanner();
          toast('QR lido');
          return;
        }
      } catch {}
      scanTimer = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    toast('Não foi possível abrir a câmera');
  }
}

function closeScanner() {
  if (scanTimer) cancelAnimationFrame(scanTimer);
  scannerStream?.getTracks().forEach((track) => track.stop());
  scannerStream = null;
  scanTimer = null;
  if (els.scanner?.open) els.scanner.close();
}

async function copyText(textarea) {
  const text = textarea.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    textarea.focus();
    textarea.select();
    document.execCommand?.('copy');
    textarea.setSelectionRange(0, 0);
  }
  toast('Código copiado');
}

async function selfTest() {
  const results = [];
  const record = (name, ok, detail = '') => results.push({ name, ok, detail });

  try {
    const original = { type: 'offer', sdp: 'v=0\r\na=entrenos-self-test\r\n' };
    const decoded = await decodeSignal(await encodeSignal(original));
    record('sinalização', decoded.type === original.type && decoded.sdp === original.sdp);
  } catch (error) {
    record('sinalização', false, error.message);
  }

  try {
    const bytes = new Uint8Array(1024 * 1024 + 137);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
    const source = new Blob([bytes]);
    const chunks = [];
    for (let offset = 0; offset < source.size; offset += CHUNK) {
      chunks.push(await source.slice(offset, Math.min(offset + CHUNK, source.size)).arrayBuffer());
    }
    const rebuilt = new Blob(chunks);
    const [a, b] = await Promise.all([sha256Blob(source), sha256Blob(rebuilt)]);
    record('chunking + SHA-256', source.size === rebuilt.size && a === b, `${chunks.length} chunks · ${source.size} bytes`);
  } catch (error) {
    record('chunking + SHA-256', false, error.message);
  }

  record('WebRTC disponível', typeof RTCPeerConnection === 'function', navigator.userAgent);
  record('contexto seguro', window.isSecureContext, location.protocol);

  const ok = results.every((r) => r.ok);
  console.table(results);
  console.info(`[EntreNós self-test] ${ok ? 'PASSOU' : 'FALHOU'}`);
  return { ok, results };
}

$('#sendChoice').onclick = () => show(els.send);
$('#receiveChoice').onclick = () => show(els.receive);
els.file.onchange = (event) => chooseFile(event.target.files[0]);
els.drop.ondragover = (event) => { event.preventDefault(); els.drop.classList.add('drag'); };
els.drop.ondragleave = () => els.drop.classList.remove('drag');
els.drop.ondrop = (event) => {
  event.preventDefault();
  els.drop.classList.remove('drag');
  chooseFile(event.dataTransfer.files[0]);
};
$('#acceptOffer').onclick = receiveOffer;
$('#applyAnswer').onclick = applyAnswer;
$('#scanOffer').onclick = () => scanInto(els.offerInput);
$('#scanAnswer').onclick = () => scanInto(els.answerInput);
$('#closeScanner').onclick = closeScanner;
$$('[data-reset]').forEach((button) => { button.onclick = reset; });
$$('[data-copy]').forEach((button) => { button.onclick = () => copyText($('#' + button.dataset.copy)); });
window.addEventListener('beforeunload', () => {
  closeScanner();
  clearConnectionTimer();
  try { pc?.close(); } catch {}
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});

window.EntreNosSelfTest = selfTest;
