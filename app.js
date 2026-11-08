(() => {
  'use strict';

  // UUIDs idénticos a Esp32Bridge/include/Config.h
  const BLE_SERVICE_UUID     = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
  const BLE_CHAR_BINARY_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
  const BLE_CHAR_JSON_UUID   = 'beb5483e-36e1-4688-b7f5-ea07361b26a9';
  const BLE_CHAR_CMD_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26aa';
  const BLE_CHAR_CFG_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26ab';

  const STORAGE_HISTORY_KEY  = 'wiiscale_history_v1';
  const STORAGE_PREFS_KEY    = 'wiiscale_prefs_v1';

  // Estado BLE
  let bleDevice = null;
  let bleServer = null;
  let charCmd   = null;
  let charCfg   = null;
  let wakeLock  = null;
  let gattChain = Promise.resolve();
  let pendingBriCmd = null;
  let briBusy = false;

  // Preferencias locales del usuario
  const prefs = {
    unit: 'kg', // 'kg' | 'lb' | 'st'
    heightCm: 0,
    autoSave: true,
    soundAlert: true,
    ...loadJson(STORAGE_PREFS_KEY, {})
  };

  let history = loadJson(STORAGE_HISTORY_KEY, []);

  // Estado en vivo de telemetría
  const state = {
    espConnected: false,
    boardState: 'DISCONNECTED',
    boardConnected: false,
    calibrated: false,
    isScanning: false,
    isStable: false,
    stabilityStars: 0,
    stabilityPct: 0,
    batteryPercent: 0,
    netKg: 0,
    tlKg: 0,
    trKg: 0,
    blKg: 0,
    brKg: 0,
    cogX: 0,
    cogY: 0,
    // Retención visual y control de auto-guardado sin duplicados
    autoSavedThisStep: false,
    holdKg: 0,
    holdUntilMs: 0,
    holdDurationSec: 10
  };

  const cogTrail = []; // Últimos 25 puntos para estela suave en el radar 2D

  // Referencias DOM
  const $ = (id) => document.getElementById(id);

  const dom = {
    btnConnectBle: $('btnConnectBle'),
    txtConnectBtn: $('txtConnectBtn'),
    badgeEsp: $('badgeEsp'),
    txtEspStatus: $('txtEspStatus'),
    badgeBoard: $('badgeBoard'),
    txtBoardStatus: $('txtBoardStatus'),
    badgeBattery: $('badgeBattery'),
    bannerUnsupported: $('bannerUnsupported'),
    bannerInstall: $('bannerInstall'),
    btnInstallPwa: $('btnInstallPwa'),
    btnDismissInstall: $('btnDismissInstall'),

    heroCard: $('heroCard'),
    lblMeasureMode: $('lblMeasureMode'),
    valMainWeight: $('valMainWeight'),
    valMainUnit: $('valMainUnit'),
    valSecondaryWeight: $('valSecondaryWeight'),
    valBmiChip: $('valBmiChip'),
    txtStabilityLabel: $('txtStabilityLabel'),
    txtStars: $('txtStars'),
    barStability: $('barStability'),

    btnTare: $('btnTare'),
    btnSaveWeight: $('btnSaveWeight'),
    btnPowerOffBoard: $('btnPowerOffBoard'),

    txtQuickSym: $('txtQuickSym'),
    barQuickLeft: $('barQuickLeft'),
    miniTL: $('miniTL'),
    miniTR: $('miniTR'),
    miniBL: $('miniBL'),
    miniBR: $('miniBR'),

    canvasCog: $('canvasCog'),
    txtCogCoords: $('txtCogCoords'),
    lblPctLeft: $('lblPctLeft'),
    lblPctRight: $('lblPctRight'),
    barLeftRight: $('barLeftRight'),
    lblPctTop: $('lblPctTop'),
    lblPctBottom: $('lblPctBottom'),
    barTopBottom: $('barTopBottom'),
    valTL: $('valTL'), barTL: $('barTL'), pctTL: $('pctTL'),
    valTR: $('valTR'), barTR: $('barTR'), pctTR: $('pctTR'),
    valBL: $('valBL'), barBL: $('barBL'), pctBL: $('pctBL'),
    valBR: $('valBR'), barBR: $('barBR'), pctBR: $('pctBR'),

    canvasHistory: $('canvasHistory'),
    historyList: $('historyList'),
    txtHistoryCount: $('txtHistoryCount'),
    btnExportCsv: $('btnExportCsv'),
    btnClearHistory: $('btnClearHistory'),

    chkMatrixEnabled: $('chkMatrixEnabled'),
    rngBrightness: $('rngBrightness'),
    lblBrightnessVal: $('lblBrightnessVal'),
    chkMatrixFlip: $('chkMatrixFlip'),
    selHoldSeconds: $('selHoldSeconds'),
    selMatrixUnit: $('selMatrixUnit'),
    lblBoardBondBadge: $('lblBoardBondBadge'),
    lblSavedMac: $('lblSavedMac'),
    lblTareOffset: $('lblTareOffset'),
    btnCfgSync: $('btnCfgSync'),
    btnCfgOff: $('btnCfgOff'),
    btnCfgForget: $('btnCfgForget'),

    inpHeightCm: $('inpHeightCm'),
    chkAutoSave: $('chkAutoSave'),
    chkSoundAlert: $('chkSoundAlert'),
    toastMsg: $('toastMsg')
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function savePrefs() {
    localStorage.setItem(STORAGE_PREFS_KEY, JSON.stringify(prefs));
  }

  function saveHistoryStore() {
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(history));
  }

  let toastTimer = null;
  function showToast(msg) {
    dom.toastMsg.textContent = msg;
    dom.toastMsg.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toastMsg.classList.add('hidden'), 2400);
  }

  // Sonido suave de confirmación sin archivos externos (Web Audio API)
  function playSuccessFeedback() {
    if (!prefs.soundAlert) return;
    if (navigator.vibrate) {
      try { navigator.vibrate([70, 40, 110]); } catch {}
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      [660, 880].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.12, now + idx * 0.11);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + idx * 0.11);
        osc.stop(now + idx * 0.11 + 0.19);
      });
    } catch {}
  }

  // Cola serializada para evitar errores "GATT operation already in progress"
  function enqueueGatt(task) {
    gattChain = gattChain.then(task, task);
    return gattChain;
  }

  async function sendBleCommand(cmdStr) {
    if (!charCmd || !state.espConnected) return;
    const bytes = new TextEncoder().encode(cmdStr);
    await enqueueGatt(async () => {
      if (!charCmd) return;
      if (charCmd.writeValueWithoutResponse) {
        await charCmd.writeValueWithoutResponse(bytes);
      } else {
        await charCmd.writeValue(bytes);
      }
    });
  }

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try { wakeLock.release(); } catch {}
      wakeLock = null;
    }
  }

  // Conexión Web Bluetooth con WiiScale-ESP32
  async function connectEsp32() {
    if (!navigator.bluetooth) {
      dom.bannerUnsupported.classList.remove('hidden');
      showToast('Abre en Google Chrome para usar Bluetooth');
      return;
    }

    if (state.espConnected && bleDevice && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
      return;
    }

    try {
      dom.txtConnectBtn.textContent = 'Buscando...';
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [BLE_SERVICE_UUID] },
          { namePrefix: 'WiiScale' }
        ],
        optionalServices: [BLE_SERVICE_UUID]
      });

      bleDevice.addEventListener('gattserverdisconnected', onEspDisconnected);

      dom.txtConnectBtn.textContent = 'Conectando...';
      bleServer = await bleDevice.gatt.connect();
      const service = await bleServer.getPrimaryService(BLE_SERVICE_UUID);

      const charBin  = await service.getCharacteristic(BLE_CHAR_BINARY_UUID);
      const charJson = await service.getCharacteristic(BLE_CHAR_JSON_UUID);
      charCmd        = await service.getCharacteristic(BLE_CHAR_CMD_UUID);

      try {
        charCfg = await service.getCharacteristic(BLE_CHAR_CFG_UUID);
      } catch {
        charCfg = null;
      }

      // Suscribir solo el canal binario 20 Hz + configuración (evita tráfico JSON redundante en radio 2.4 GHz)
      await enqueueGatt(async () => {
        charBin.addEventListener('characteristicvaluechanged', onBinaryTelemetry);
        await charBin.startNotifications();
      });

      if (charCfg) {
        await enqueueGatt(async () => {
          charCfg.addEventListener('characteristicvaluechanged', onCfgChanged);
          await charCfg.startNotifications();
          const initialCfg = await charCfg.readValue();
          parseCfgPayload(initialCfg);
        });
      }

      state.espConnected = true;
      await requestWakeLock();
      setEspControlsEnabled(true);
      updateHeaderStatus();
      showToast('Conectado a WiiScale-ESP32');
    } catch (err) {
      if (err && err.name !== 'NotFoundError') {
        console.error(err);
        showToast('No se pudo conectar por Bluetooth');
      }
      onEspDisconnected();
    }
  }

  function onEspDisconnected() {
    state.espConnected = false;
    state.boardConnected = false;
    state.calibrated = false;
    charCmd = null;
    charCfg = null;
    releaseWakeLock();
    setEspControlsEnabled(false);
    updateHeaderStatus();
    renderScaleUI();
  }

  function setEspControlsEnabled(en) {
    [
      dom.btnTare,
      dom.btnSaveWeight,
      dom.btnPowerOffBoard,
      dom.chkMatrixEnabled,
      dom.rngBrightness,
      dom.chkMatrixFlip,
      dom.selHoldSeconds,
      dom.selMatrixUnit,
      dom.btnCfgSync,
      dom.btnCfgOff,
      dom.btnCfgForget
    ].forEach((el) => { if (el) el.disabled = !en; });
  }

  // Decodificador binario 20 Hz (BleBinaryPacket de 36 bytes little-endian)
  function onBinaryTelemetry(event) {
    const dv = event.target.value;
    if (!dv || dv.byteLength < 36) return;

    const netKg   = dv.getFloat32(0, true);
    const tlKg    = dv.getFloat32(8, true);
    const trKg    = dv.getFloat32(12, true);
    const blKg    = dv.getFloat32(16, true);
    const brKg    = dv.getFloat32(20, true);
    const cogX    = dv.getFloat32(24, true);
    const cogY    = dv.getFloat32(28, true);
    const batPct  = dv.getUint8(32);
    const stars   = dv.getUint8(33);
    const stabPct = dv.getUint8(34);
    const flags   = dv.getUint8(35);

    const prevStable = state.isStable;

    state.netKg          = netKg;
    state.tlKg           = tlKg;
    state.trKg           = trKg;
    state.blKg           = blKg;
    state.brKg           = brKg;
    state.cogX           = cogX;
    state.cogY           = cogY;
    state.batteryPercent = batPct;
    state.stabilityStars = stars;
    state.stabilityPct   = stabPct;
    state.boardConnected = (flags & 0x01) !== 0;
    state.isStable       = (flags & 0x02) !== 0;
    state.isScanning     = (flags & 0x04) !== 0;
    state.calibrated     = (flags & 0x08) !== 0;

    handleStabilityAndHold(prevStable);
    updateHeaderStatus();
    renderScaleUI();
    renderBalanceUI();
  }

  // Respaldo y lectura del nombre exacto de estado (5 Hz JSON)
  function onJsonTelemetry(event) {
    try {
      const txt = new TextDecoder().decode(event.target.value);
      const obj = JSON.parse(txt);
      if (obj.st) {
        state.boardState = obj.st;
        updateHeaderStatus();
      }
    } catch {}
  }

  function onCfgChanged(event) {
    parseCfgPayload(event.target.value);
  }

  function parseCfgPayload(dataView) {
    try {
      const txt = new TextDecoder().decode(dataView);
      const cfg = JSON.parse(txt);

      if (typeof cfg.mat === 'number') dom.chkMatrixEnabled.checked = cfg.mat === 1;
      if (typeof cfg.br === 'number') {
        dom.rngBrightness.value = String(cfg.br);
        dom.lblBrightnessVal.textContent = `${cfg.br} / 15`;
      }
      if (typeof cfg.flip === 'number') dom.chkMatrixFlip.checked = cfg.flip === 1;
      if (typeof cfg.hold === 'number') {
        state.holdDurationSec = cfg.hold;
        dom.selHoldSeconds.value = String(cfg.hold);
      }
      if (typeof cfg.lbs === 'number') {
        dom.selMatrixUnit.value = String(cfg.lbs);
      }
      if (cfg.mac) {
        dom.lblSavedMac.textContent = cfg.mac === 'NONE' ? 'Sin vincular' : cfg.mac;
      }
      if (typeof cfg.bonded === 'number') {
        dom.lblBoardBondBadge.textContent = cfg.bonded === 1
          ? '✓ Vínculo Permanente (Botón Power)'
          : 'Pendiente SYNC';
      }
      if (typeof cfg.tare === 'number') {
        dom.lblTareOffset.textContent = `${cfg.tare.toFixed(2)} kg`;
      }
      if (cfg.st) {
        state.boardState = cfg.st;
        updateHeaderStatus();
      }
    } catch (e) {
      console.warn('Cfg parse warning:', e);
    }
  }

  function handleStabilityAndHold(prevStable) {
    const now = Date.now();

    if (state.boardConnected && state.netKg < 1.5) {
      state.autoSavedThisStep = false;
    }

    if (state.boardConnected && state.isStable && state.netKg >= 3.0) {
      if (state.holdDurationSec > 0) {
        state.holdKg = state.netKg;
        state.holdUntilMs = now + state.holdDurationSec * 1000;
      }
      if (!prevStable) {
        playSuccessFeedback();
      }
      if (prefs.autoSave && !state.autoSavedThisStep && state.netKg >= 10.0) {
        state.autoSavedThisStep = true;
        addHistoryRecord(state.netKg, 'Auto-estabilizado');
        showToast(`✓ Peso guardado: ${formatWeight(state.netKg, prefs.unit).full}`);
      }
    } else if (now < state.holdUntilMs && state.netKg >= 1.8 && !state.autoSavedThisStep) {
      // Al volver a pisar o tocar la tabla, liberar Hold previo de inmediato
      state.holdUntilMs = 0;
    }

    if (state.boardConnected && state.netKg >= 0.8) {
      cogTrail.push({ x: state.cogX, y: state.cogY });
      if (cogTrail.length > 26) cogTrail.shift();
    } else if (cogTrail.length > 0) {
      cogTrail.shift();
    }
  }

  // Formateador de unidades (KG, LBS, Stone)
  function formatWeight(kg, unit) {
    const cleanKg = Math.max(0, kg);
    const lbs = cleanKg * 2.2046226;

    if (unit === 'lb') {
      return {
        num: lbs.toFixed(1),
        unit: 'lb',
        sub: `${cleanKg.toFixed(2)} kg`,
        full: `${lbs.toFixed(1)} lb`
      };
    }
    if (unit === 'st') {
      const totalLbs = Math.round(lbs * 10) / 10;
      const stones = Math.floor(totalLbs / 14);
      const remLbs = (totalLbs - stones * 14).toFixed(1);
      return {
        num: `${stones}:${remLbs.padStart(4, '0')}`,
        unit: 'st',
        sub: `${cleanKg.toFixed(2)} kg · ${lbs.toFixed(1)} lb`,
        full: `${stones} st ${remLbs} lb`
      };
    }
    return {
      num: cleanKg.toFixed(2),
      unit: 'kg',
      sub: `${lbs.toFixed(1)} lb`,
      full: `${cleanKg.toFixed(2)} kg`
    };
  }

  function updateHeaderStatus() {
    if (!state.espConnected) {
      dom.badgeEsp.className = 'status-pill offline';
      dom.txtEspStatus.textContent = 'ESP32 Desconectado';
      dom.badgeBoard.classList.add('hidden');
      dom.badgeBattery.classList.add('hidden');
      dom.btnConnectBle.classList.remove('connected');
      dom.txtConnectBtn.textContent = 'Conectar';
      return;
    }

    dom.badgeEsp.className = 'status-pill online';
    dom.txtEspStatus.textContent = 'ESP32 Conectado';
    dom.btnConnectBle.classList.add('connected');
    dom.txtConnectBtn.textContent = 'Salir';
    dom.badgeBoard.classList.remove('hidden');

    if (state.boardConnected) {
      dom.badgeBoard.className = 'status-pill online';
      dom.txtBoardStatus.textContent = 'Tabla Lista';
      if (state.batteryPercent > 0) {
        dom.badgeBattery.classList.remove('hidden');
        dom.badgeBattery.textContent = `🔋 ${state.batteryPercent}%`;
      }
    } else if (state.isScanning || state.boardState === 'SCANNING_SYNC' || state.boardState === 'BONDING') {
      dom.badgeBoard.className = 'status-pill scanning';
      dom.txtBoardStatus.textContent = 'Buscando SYNC...';
      dom.badgeBattery.classList.add('hidden');
    } else if (state.boardState === 'CALIBRATING' || state.boardState === 'CONN_CTRL' || state.boardState === 'CONN_INTR') {
      dom.badgeBoard.className = 'status-pill scanning';
      dom.txtBoardStatus.textContent = 'Calibrando...';
    } else {
      dom.badgeBoard.className = 'status-pill neutral';
      dom.txtBoardStatus.textContent = 'Pulsa Power en Tabla';
      dom.badgeBattery.classList.add('hidden');
    }
  }

  function renderScaleUI() {
    const now = Date.now();
    // Modo HOLD solo cuando ya te bajaste de la tabla (< 1.5 kg); mientras sigas arriba se mueve 100% en vivo
    const inHold = now < state.holdUntilMs && (!state.boardConnected || state.netKg < 1.5);
    const activeKg = inHold ? state.holdKg : (state.boardConnected ? state.netKg : 0);

    const fmt = formatWeight(activeKg, prefs.unit);
    dom.valMainWeight.textContent = fmt.num;
    dom.valMainUnit.textContent = fmt.unit;
    dom.valSecondaryWeight.textContent = fmt.sub;

    // IMC opcional si configuró estatura
    if (prefs.heightCm >= 80 && activeKg >= 10) {
      const m = prefs.heightCm / 100;
      const bmi = activeKg / (m * m);
      dom.valBmiChip.textContent = `IMC: ${bmi.toFixed(1)}`;
      dom.valBmiChip.classList.remove('hidden');
    } else {
      dom.valBmiChip.classList.add('hidden');
    }

    // Estado visual de la tarjeta principal
    if (!state.espConnected) {
      dom.heroCard.classList.remove('stable');
      dom.lblMeasureMode.textContent = 'TOCA "CONECTAR" ARRIBA PARA INICIAR';
      dom.txtStabilityLabel.textContent = 'Sin conexión Bluetooth';
      dom.txtStars.textContent = '☆☆☆☆☆';
      dom.barStability.style.width = '0%';
      return;
    }

    if (inHold) {
      const remSec = Math.ceil((state.holdUntilMs - now) / 1000);
      dom.heroCard.classList.add('stable');
      dom.lblMeasureMode.textContent = `✓ PESO FIJADO (HOLD ${remSec}s)`;
      dom.txtStabilityLabel.textContent = 'Medición bloqueada (±20g)';
      dom.txtStars.textContent = '★★★★★';
      dom.barStability.style.width = '100%';
    } else if (!state.boardConnected) {
      dom.heroCard.classList.remove('stable');
      dom.lblMeasureMode.textContent = state.isScanning
        ? 'PRESIONA EL BOTÓN ROJO SYNC...'
        : 'PRESIONA EL BOTÓN FRONTAL POWER EN LA TABLA';
      dom.txtStabilityLabel.textContent = 'Esperando encendido de Wii Balance Board';
      dom.txtStars.textContent = '☆☆☆☆☆';
      dom.barStability.style.width = '0%';
    } else {
      dom.heroCard.classList.toggle('stable', state.isStable);
      dom.lblMeasureMode.textContent = state.isStable
        ? '✓ PROMEDIO 4S FIJADO'
        : (state.netKg > 2.0 ? 'PROMEDIANDO 4 SEGUNDOS...' : 'SUBE A LA WII BALANCE BOARD');
      dom.txtStabilityLabel.textContent = state.isStable
        ? '✓ Peso bloqueado (CoG en vivo)'
        : (state.netKg > 2.0 ? `Promediando precisión (${Math.min(99, state.stabilityPct)}%)...` : 'Listo en cero (0.00 kg)');
      const s = Math.max(0, Math.min(5, state.stabilityStars));
      dom.txtStars.textContent = '★'.repeat(s) + '☆'.repeat(5 - s);
      dom.barStability.style.width = `${Math.min(100, state.stabilityPct)}%`;
    }

    // Mini resumen en pestaña 1
    const sum = state.tlKg + state.trKg + state.blKg + state.brKg;
    const leftPct = sum > 0.8 ? Math.round(((state.tlKg + state.blKg) / sum) * 100) : 50;
    const rightPct = 100 - leftPct;
    dom.txtQuickSym.textContent = `${leftPct}% Izq · ${rightPct}% Der`;
    dom.barQuickLeft.style.width = `${leftPct}%`;

    const mult = prefs.unit === 'lb' ? 2.20462 : 1;
    const uLbl = prefs.unit === 'lb' ? 'lb' : 'kg';
    dom.miniTL.textContent = `${(state.tlKg * mult).toFixed(1)} ${uLbl}`;
    dom.miniTR.textContent = `${(state.trKg * mult).toFixed(1)} ${uLbl}`;
    dom.miniBL.textContent = `${(state.blKg * mult).toFixed(1)} ${uLbl}`;
    dom.miniBR.textContent = `${(state.brKg * mult).toFixed(1)} ${uLbl}`;
  }

  function renderBalanceUI() {
    const sum = state.tlKg + state.trKg + state.blKg + state.brKg;
    let pTL = 25, pTR = 25, pBL = 25, pBR = 25;
    if (sum > 0.8) {
      pTL = (state.tlKg / sum) * 100;
      pTR = (state.trKg / sum) * 100;
      pBL = (state.blKg / sum) * 100;
      pBR = (state.brKg / sum) * 100;
    }

    const pLeft = Math.round(pTL + pBL);
    const pRight = 100 - pLeft;
    const pTop = Math.round(pTL + pTR);
    const pBottom = 100 - pTop;

    dom.txtCogCoords.textContent = `X: ${state.cogX >= 0 ? '+' : ''}${state.cogX.toFixed(2)} | Y: ${state.cogY >= 0 ? '+' : ''}${state.cogY.toFixed(2)}`;
    dom.lblPctLeft.textContent = `${pLeft}%`;
    dom.lblPctRight.textContent = `${pRight}%`;
    dom.barLeftRight.style.width = `${pLeft}%`;

    dom.lblPctTop.textContent = `${pTop}%`;
    dom.lblPctBottom.textContent = `${pBottom}%`;
    dom.barTopBottom.style.width = `${pTop}%`;

    const mult = prefs.unit === 'lb' ? 2.20462 : 1;
    const uLbl = prefs.unit === 'lb' ? 'lb' : 'kg';

    const updateSensor = (valEl, barEl, pctEl, kg, pct) => {
      valEl.textContent = `${(kg * mult).toFixed(2)} ${uLbl}`;
      barEl.style.width = `${Math.min(100, pct)}%`;
      pctEl.textContent = `${Math.round(pct)}%`;
    };

    updateSensor(dom.valTL, dom.barTL, dom.pctTL, state.tlKg, pTL);
    updateSensor(dom.valTR, dom.barTR, dom.pctTR, state.trKg, pTR);
    updateSensor(dom.valBL, dom.barBL, dom.pctBL, state.blKg, pBL);
    updateSensor(dom.valBR, dom.barBR, dom.pctBR, state.brKg, pBR);

    drawCogRadar();
  }

  function drawCogRadar() {
    const canvas = dom.canvasCog;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Silueta de la tabla
    const padX = 22, padY = 18;
    const bw = w - padX * 2;
    const bh = h - padY * 2;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(padX, padY, bw, bh, 18);
    ctx.stroke();

    // Ejes centrales y anillos de referencia
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, padY); ctx.lineTo(cx, h - padY);
    ctx.moveTo(padX, cy); ctx.lineTo(w - padX, cy);
    ctx.stroke();

    [28, 62].forEach((r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Estela reciente
    for (let i = 0; i < cogTrail.length; i++) {
      const pt = cogTrail[i];
      const px = cx + pt.x * (bw * 0.42);
      const py = cy + pt.y * (bh * 0.42);
      const alpha = ((i + 1) / cogTrail.length) * 0.45;
      ctx.fillStyle = `rgba(6, 182, 212, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Punto activo CoG
    const activeX = cx + (state.boardConnected ? state.cogX : 0) * (bw * 0.42);
    const activeY = cy + (state.boardConnected ? state.cogY : 0) * (bh * 0.42);

    const grad = ctx.createRadialGradient(activeX, activeY, 2, activeX, activeY, 22);
    grad.addColorStop(0, state.isStable ? 'rgba(16, 185, 129, 0.9)' : 'rgba(6, 182, 212, 0.9)');
    grad.addColorStop(1, 'rgba(6, 182, 212, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(activeX, activeY, 22, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(activeX, activeY, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Gestión de Historial y Gráfica
  function addHistoryRecord(kg, note) {
    const sum = state.tlKg + state.trKg + state.blKg + state.brKg;
    const leftPct = sum > 0.8 ? Math.round(((state.tlKg + state.blKg) / sum) * 100) : 50;
    const rec = {
      id: Date.now().toString(36),
      ts: Date.now(),
      kg: Number(kg.toFixed(2)),
      leftPct,
      note
    };
    history.unshift(rec);
    if (history.length > 60) history.length = 60;
    saveHistoryStore();
    renderHistoryUI();
  }

  function renderHistoryUI() {
    dom.txtHistoryCount.textContent = `${history.length} ${history.length === 1 ? 'pesaje' : 'pesajes'}`;

    if (history.length === 0) {
      dom.historyList.innerHTML = '<p class="empty-msg">Aún no hay pesajes registrados. Al subir a la tabla y quedar estable, tu peso se guardará automáticamente.</p>';
      drawHistoryChart();
      return;
    }

    dom.historyList.innerHTML = history.map((item, idx) => {
      const dt = new Date(item.ts);
      const dateStr = dt.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }) + ' ' +
                      dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      const fmt = formatWeight(item.kg, prefs.unit);
      const prev = history[idx + 1];
      let deltaTxt = '';
      if (prev) {
        const diff = item.kg - prev.kg;
        if (Math.abs(diff) >= 0.05) {
          deltaTxt = ` · ${diff > 0 ? '+' : ''}${diff.toFixed(2)} kg`;
        }
      }
      return `
        <div class="history-item">
          <div class="history-meta">
            <strong>${dateStr}</strong>
            <span>${item.note} · ${item.leftPct}% Izq / ${100 - item.leftPct}% Der${deltaTxt}</span>
          </div>
          <div class="history-right">
            <span class="history-weight">${fmt.full}</span>
            <button class="btn btn-ghost btn-sm" data-del="${item.id}" type="button" title="Eliminar">✕</button>
          </div>
        </div>
      `;
    }).join('');

    dom.historyList.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        history = history.filter((r) => r.id !== id);
        saveHistoryStore();
        renderHistoryUI();
      });
    });

    drawHistoryChart();
  }

  function drawHistoryChart() {
    const canvas = dom.canvasHistory;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const pts = history.slice(0, 15).reverse();
    if (pts.length < 2) {
      ctx.fillStyle = '#64748B';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Guarda al menos 2 pesajes para ver tu gráfica de evolución', w / 2, h / 2 + 4);
      return;
    }

    const vals = pts.map((p) => prefs.unit === 'lb' ? p.kg * 2.20462 : p.kg);
    const minV = Math.min(...vals) - 0.8;
    const maxV = Math.max(...vals) + 0.8;
    const range = Math.max(1, maxV - minV);

    const padX = 24, padY = 22;
    const plotW = w - padX * 2;
    const plotH = h - padY * 2;

    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    const coords = vals.map((v, i) => ({
      x: padX + (i / (vals.length - 1)) * plotW,
      y: padY + plotH - ((v - minV) / range) * plotH,
      v
    }));

    coords.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    coords.forEach((p) => {
      ctx.fillStyle = '#10B981';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = '#94A3B8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(vals[0].toFixed(1), coords[0].x - 8, Math.max(12, coords[0].y - 8));
    ctx.textAlign = 'right';
    const last = coords[coords.length - 1];
    ctx.fillText(last.v.toFixed(1), last.x + 8, Math.max(12, last.y - 8));
  }

  function exportCsv() {
    if (history.length === 0) {
      showToast('No hay registros para exportar');
      return;
    }
    const header = 'Fecha,Hora,Peso_KG,Peso_LB,Izquierda_Pct,Derecha_Pct,Origen\n';
    const rows = history.map((r) => {
      const d = new Date(r.ts);
      const fecha = d.toISOString().slice(0, 10);
      const hora = d.toTimeString().slice(0, 8);
      const lb = (r.kg * 2.2046226).toFixed(2);
      return `${fecha},${hora},${r.kg.toFixed(2)},${lb},${r.leftPct},${100 - r.leftPct},"${r.note}"`;
    }).join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wiiscale_historial_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Enlace de eventos UI
  function bindEvents() {
    if (!navigator.bluetooth) {
      dom.bannerUnsupported.classList.remove('hidden');
    }

    dom.btnConnectBle.addEventListener('click', connectEsp32);

    // Pestañas inferiores
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const target = $(btn.getAttribute('data-target'));
        if (target) target.classList.add('active');
        drawCogRadar();
        drawHistoryChart();
      });
    });

    // Selector de unidades Web
    document.querySelectorAll('.unit-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.unit === prefs.unit);
      btn.addEventListener('click', () => {
        prefs.unit = btn.dataset.unit;
        savePrefs();
        document.querySelectorAll('.unit-btn').forEach((b) => b.classList.toggle('active', b === btn));
        renderScaleUI();
        renderBalanceUI();
        renderHistoryUI();
      });
    });

    // Acciones rápidas Báscula
    dom.btnTare.addEventListener('click', async () => {
      state.holdUntilMs = 0;
      await sendBleCommand('TARE');
      showToast('⚖️ Puesta a cero enviada al ESP32');
    });

    dom.btnSaveWeight.addEventListener('click', () => {
      const now = Date.now();
      const kg = (now < state.holdUntilMs) ? state.holdKg : state.netKg;
      if (kg < 0.4) {
        showToast('Sube a la tabla para guardar un pesaje');
        return;
      }
      addHistoryRecord(kg, 'Guardado manual');
      showToast(`💾 Guardado: ${formatWeight(kg, prefs.unit).full}`);
    });

    const powerOffHandler = async () => {
      state.holdUntilMs = 0;
      await sendBleCommand('OFF');
      showToast('⏻ Tabla apagada (puedes prenderla con Power)');
    };
    dom.btnPowerOffBoard.addEventListener('click', powerOffHandler);
    dom.btnCfgOff.addEventListener('click', powerOffHandler);

    // Controles de la Matriz LED MAX7219 en el ESP32
    dom.chkMatrixEnabled.addEventListener('change', () => {
      sendBleCommand(`MAT:${dom.chkMatrixEnabled.checked ? 1 : 0}`);
    });

    dom.rngBrightness.addEventListener('input', () => {
      const v = dom.rngBrightness.value;
      dom.lblBrightnessVal.textContent = `${v} / 15`;
      pendingBriCmd = `BRI:${v}`;
      if (!briBusy) {
        briBusy = true;
        (async () => {
          while (pendingBriCmd !== null) {
            const next = pendingBriCmd;
            pendingBriCmd = null;
            await sendBleCommand(next);
          }
          briBusy = false;
        })();
      }
    });

    dom.chkMatrixFlip.addEventListener('change', () => {
      sendBleCommand(`FLIP:${dom.chkMatrixFlip.checked ? 1 : 0}`);
    });

    dom.selHoldSeconds.addEventListener('change', () => {
      const sec = Number(dom.selHoldSeconds.value);
      state.holdDurationSec = sec;
      sendBleCommand(`HOLD:${sec}`);
    });

    dom.selMatrixUnit.addEventListener('change', () => {
      sendBleCommand(`UNIT:${dom.selMatrixUnit.value}`);
    });

    dom.btnCfgSync.addEventListener('click', async () => {
      await sendBleCommand('SYNC');
      showToast('🔴 ESP32 buscando botón rojo SYNC (15s)...');
    });

    dom.btnCfgForget.addEventListener('click', async () => {
      if (confirm('¿Borrar el vínculo Bluetooth guardado en el ESP32 para emparejar una tabla distinta?')) {
        await sendBleCommand('FORGET');
        showToast('Vínculo eliminado. Presiona SYNC en la nueva tabla.');
      }
    });

    // Preferencias locales del celular
    dom.inpHeightCm.value = prefs.heightCm > 0 ? String(prefs.heightCm) : '';
    dom.chkAutoSave.checked = !!prefs.autoSave;
    dom.chkSoundAlert.checked = !!prefs.soundAlert;

    dom.inpHeightCm.addEventListener('change', () => {
      prefs.heightCm = Math.max(0, Math.min(250, Number(dom.inpHeightCm.value) || 0));
      savePrefs();
      renderScaleUI();
    });

    dom.chkAutoSave.addEventListener('change', () => {
      prefs.autoSave = dom.chkAutoSave.checked;
      savePrefs();
    });

    dom.chkSoundAlert.addEventListener('change', () => {
      prefs.soundAlert = dom.chkSoundAlert.checked;
      savePrefs();
    });

    dom.btnExportCsv.addEventListener('click', exportCsv);
    dom.btnClearHistory.addEventListener('click', () => {
      if (history.length > 0 && confirm('¿Borrar todo el historial de pesajes guardado en este dispositivo?')) {
        history = [];
        saveHistoryStore();
        renderHistoryUI();
      }
    });

    // Temporizador de 500ms para refrescar contador regresivo de HOLD en pantalla
    setInterval(() => {
      if (Date.now() < state.holdUntilMs + 600) {
        renderScaleUI();
      }
    }, 500);
  }

  // Soporte de instalación PWA + Service Worker
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    dom.bannerInstall.classList.remove('hidden');
  });

  dom.btnInstallPwa.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    dom.bannerInstall.classList.add('hidden');
  });

  dom.btnDismissInstall.addEventListener('click', () => {
    dom.bannerInstall.classList.add('hidden');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // Inicialización
  bindEvents();
  updateHeaderStatus();
  renderScaleUI();
  renderBalanceUI();
  renderHistoryUI();
})();

