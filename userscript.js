// ==UserScript==
// @name         GeoFS-Flightradar-receiver
// @namespace    http://tampermonkey.net/
// @version      1.9.3
// @description  flightradar sender with editable callsign + flight info
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @updateURL   https://github.com/seabus0316/GeoFS-flightradar/raw/refs/heads/main/user.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  const WS_URL = 'wss://geofs-flightradar.duckdns.org/ws';
  const SEND_INTERVAL_MS = 500;
  /*************/

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  // --- NEW: manual Callsign variable ---
  let mainCallsign = "NICO";   // default
  let flightInfo = { departure: '', arrival: '', flightNo: '', squawk: '' };
  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = '';

  // ===== Update check =====
  const CURRENT_VERSION = '1.9.3';
  const VERSION_JSON_URL = 'https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/main/version.json';
  const UPDATE_URL = 'https://raw.githubusercontent.com/seabus0316/GeoFS-flightradar/main/userscript.js';

  (function checkUpdate() {
    fetch(VERSION_JSON_URL)
      .then(r => r.json())
      .then(data => {
        if (data.version && data.version !== CURRENT_VERSION) {
          showToast("⚠ Update available: " + data.version);
        }
      })
      .catch(() => {});
  })();

  // --- WebSocket ---
  let ws;
  function connect() {
    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected');
        safeSend({ type: 'hello', role: 'player' });
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        setTimeout(connect, 2000);
      });
      ws.addEventListener('error', (e) => {
        console.warn('[ATC-Reporter] WS error', e);
        try { ws.close(); } catch {}
      });
    } catch (e) {
      console.warn('[ATC-Reporter] WS connect error', e);
      setTimeout(connect, 2000);
    }
  }
  connect();

  function safeSend(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  // ==== helpers ====
  function getAircraftName() {
    return geofs?.aircraft?.instance?.aircraftRecord?.name || 'Unkown';
  }

  // ---- NEW: callsign function ----
  function getPlayerCallsign() {
    return mainCallsign?.trim() || "UNKOWN";
  }

  // --- AGL ---
  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude;
      const groundElevationFeet = geofs?.animation?.values?.groundElevationFeet;
      const aircraft = geofs?.aircraft?.instance;

      if (
        typeof altitudeMSL === 'number' &&
        typeof groundElevationFeet === 'number' &&
        aircraft?.collisionPoints?.length >= 2 &&
        typeof aircraft.collisionPoints[aircraft.collisionPoints.length - 2]?.worldPosition?.[2] === 'number'
      ) {
        const collisionZFeet =
          aircraft.collisionPoints[aircraft.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        return Math.round((altitudeMSL - groundElevationFeet) + collisionZFeet);
      }
    } catch (err) {
      console.warn('[ATC-Reporter] AGL calculation error:', err);
    }
    return null;
  }

  function checkTakeoff() {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
    }
    wasOnGround = onGround;
  }

  function readSnapshot() {
    try {
      const inst = geofs?.aircraft?.instance;
      if (!inst) return null;

      const [lat, lon, altMeters] = inst.llaLocation || [];
      if (typeof lat !== "number") return null;

      const altMSL = (typeof altMeters === 'number') ? altMeters * 3.28084 : 0;
      const altAGL = calculateAGL();
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      const speed = geofs?.animation?.values?.kias || 0;

      return { lat, lon, altMSL, altAGL, heading, speed };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  function buildPayload(snap) {
    checkTakeoff();

    let flightPlan = [];
    try {
      if (geofs.flightPlan?.export) {
        flightPlan = geofs.flightPlan.export();
      }
    } catch {}

    return {
      id: getPlayerCallsign(),
      callsign: getPlayerCallsign(),
      type: getAircraftName(),
      lat: snap.lat,
      lon: snap.lon,
      alt: typeof snap.altAGL === "number" ? snap.altAGL : Math.round(snap.altMSL),
      altMSL: Math.round(snap.altMSL),
      heading: Math.round(snap.heading),
      speed: Math.round(snap.speed),
      flightNo: flightInfo.flightNo,
      departure: flightInfo.departure,
      arrival: flightInfo.arrival,
      takeoffTime: takeoffTimeUTC,
      squawk: flightInfo.squawk,
      flightPlan,
      nextWaypoint: geofs.flightPlan?.trackedWaypoint?.ident || null,
      userId: geofs?.userRecord?.id || null
    };
  }

  // send loop
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const snap = readSnapshot();
    if (!snap) return;
    safeSend({ type: 'position_update', payload: buildPayload(snap) });
  }, SEND_INTERVAL_MS);

  // toast
  function showToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.position = 'fixed';
    t.style.bottom = '20px';
    t.style.right = '20px';
    t.style.background = 'rgba(0,0,0,0.85)';
    t.style.color = '#fff';
    t.style.padding = '8px 12px';
    t.style.borderRadius = '6px';
    t.style.zIndex = 999999;
    t.style.fontSize = '13px';
    t.style.opacity = '0';
    t.style.transition = '.3s';
    document.body.appendChild(t);
    requestAnimationFrame(() => t.style.opacity = '1');
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 2000);
  }

  // === UI ===
  function injectFlightUI() {
    flightUI = document.createElement('div');
    flightUI.style.position = 'fixed';
    flightUI.style.bottom = '280px';
    flightUI.style.right = '6px';
    flightUI.style.background = 'rgba(0,0,0,0.6)';
    flightUI.style.padding = '8px';
    flightUI.style.borderRadius = '6px';
    flightUI.style.color = '#fff';
    flightUI.style.fontSize = '12px';
    flightUI.style.zIndex = 999999;

    flightUI.innerHTML = `
      <div>CS: <input id="csInput" style="width:60px"></div>
      <div>Dep: <input id="depInput" style="width:60px"></div>
      <div>Arr: <input id="arrInput" style="width:60px"></div>
      <div>Flt#: <input id="fltInput" style="width:60px"></div>
      <div>SQK: <input id="sqkInput" style="width:60px" maxlength="4"></div>
      <button id="saveBtn">Save</button>
    `;

    document.body.appendChild(flightUI);

    // uppercase
    ["csInput","depInput","arrInput","fltInput","sqkInput"].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener("input", () => {
        el.value = el.value.toUpperCase();
      });
    });

    // callsign update
    document.getElementById("csInput").addEventListener("input", () => {
      mainCallsign = document.getElementById("csInput").value.trim().toUpperCase();
      showToast("Callsign = " + mainCallsign);
    });

    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      flightInfo.squawk = document.getElementById('sqkInput').value.trim();
      showToast('Flight info saved');
    };
  }
  injectFlightUI();

  // toggle with W
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') {
      flightUI.style.display =
        flightUI.style.display === 'none' ? 'block' : 'none';
      showToast(flightUI.style.display === 'none' ? 'UI Hidden' : 'UI Shown');
    }
  });

  // stop GeoFS hotkey when typing
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") e.stopPropagation();
  }, true);

})();
