import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle, AlertCircle, ShieldCheck, Waves, Wind, Thermometer, MapPin, Clock,
  Send, Search, LocateFixed, RefreshCw, ExternalLink, Compass, ArrowUpDown, Navigation
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot } from 'firebase/firestore';

/* ---------- Firebase ---------- */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, 'default');
const appId = 'ocean-alert';

/* ---------- Live data sources ----------
   Open-Meteo Marine + Forecast + Geocoding: free, no API key, CORS-enabled.
   INCOIS: its alert API / RSS feed needs an APPID that you request from
   osf@incois.gov.in. Once you have it, call it from a small backend proxy
   and plug the result into the "INCOIS alerts" card below. */
const INCOIS_ALERTS_PAGE = 'https://incois.gov.in/site/services/hwa.jsp';
const INCOIS_OSF_PAGE = 'https://incois.gov.in/site/services/osf.jsp';
const REFRESH_MS = 10 * 60 * 1000;

const DEFAULT_PLACE = { name: 'Mumbai', admin1: 'Maharashtra', country: 'India', latitude: 19.076, longitude: 72.8777 };

const compass = (deg) => {
  if (deg == null) return '–';
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
};
const fmt = (v, unit, d = 1) => (v == null ? '–' : `${Number(v).toFixed(d)}${unit}`);

async function fetchConditions(lat, lon) {
  const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
    `&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction,sea_level_height_msl` +
    `&hourly=wave_height&forecast_days=2&timezone=auto`;
  const windUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=auto`;
  const [m, w] = await Promise.all([fetch(marineUrl), fetch(windUrl)]);
  if (!m.ok) throw new Error('Marine data service is unavailable right now.');
  const marine = await m.json();
  const wind = w.ok ? await w.json() : null;
  if (marine.current?.wave_height == null && marine.current?.sea_surface_temperature == null) {
    throw new Error('No ocean data for this point. Pick a place on or very near the coast.');
  }
  const now = marine.current?.time;
  const idx = marine.hourly?.time?.findIndex((t) => t >= now) ?? 0;
  const trend = marine.hourly?.wave_height?.slice(idx, idx + 7) || [];
  return { marine: marine.current, wind: wind?.current, trend, updated: now };
}

function assess(c) {
  if (!c) return { level: 'SAFE', text: 'Search a coastal area to see live conditions', tone: 'safe', reasons: [] };
  const wave = c.marine.wave_height ?? 0;
  const swell = c.marine.swell_wave_height ?? 0;
  const gust = c.wind?.wind_gusts_10m ?? 0;
  const reasons = [];
  let score = 0;
  if (wave >= 2.5) { score = 2; reasons.push(`Waves ${wave.toFixed(1)} m`); } else if (wave >= 1.5) { score = Math.max(score, 1); reasons.push(`Waves ${wave.toFixed(1)} m`); }
  if (swell >= 2.5) { score = 2; reasons.push(`Swell ${swell.toFixed(1)} m`); } else if (swell >= 1.5) { score = Math.max(score, 1); reasons.push(`Swell ${swell.toFixed(1)} m`); }
  if (gust >= 60) { score = 2; reasons.push(`Gusts ${Math.round(gust)} km/h`); } else if (gust >= 40) { score = Math.max(score, 1); reasons.push(`Gusts ${Math.round(gust)} km/h`); }
  if (score === 2) return { level: 'DANGER', text: 'Rough sea. Stay away from the water and keep small boats ashore', tone: 'danger', reasons };
  if (score === 1) return { level: 'WARNING', text: 'Moderate sea. Take care near the shore and in small craft', tone: 'warn', reasons };
  return { level: 'SAFE', text: 'Normal coastal conditions at this location', tone: 'safe', reasons: ['Waves, swell and wind are within normal range'] };
}

const TONES = {
  safe: { bar: 'from-emerald-500/20 to-emerald-500/0', ring: 'border-emerald-400/40', text: 'text-emerald-300', Icon: ShieldCheck },
  warn: { bar: 'from-amber-500/25 to-amber-500/0', ring: 'border-amber-400/50', text: 'text-amber-300', Icon: AlertCircle },
  danger: { bar: 'from-red-500/30 to-red-500/0', ring: 'border-red-400/60', text: 'text-red-300', Icon: AlertTriangle },
};
const sevChip = (s) => s === 'High' ? 'bg-red-500/15 text-red-300 border-red-500/30'
  : s === 'Medium' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
  : 'bg-sky-500/15 text-sky-300 border-sky-500/30';

const inputCls = 'w-full rounded-lg bg-slate-900 border border-slate-700 text-slate-100 placeholder-slate-500 px-3 py-2.5 text-sm focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400';

function Stat({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs"><Icon size={15} className="text-cyan-400" />{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-50 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Sparkline({ values }) {
  if (!values.length) return null;
  const max = Math.max(...values, 0.5);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${28 - (v / max) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" className="w-full h-10" preserveAspectRatio="none" aria-label="Wave height next 6 hours">
      <polyline points={pts} fill="none" stroke="#22d3ee" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function OceanAlert() {
  const [user, setUser] = useState(null);
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [place, setPlace] = useState(DEFAULT_PLACE);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [cond, setCond] = useState(null);
  const [loadingCond, setLoadingCond] = useState(false);
  const [condError, setCondError] = useState('');

  const [form, setForm] = useState({ location: '', hazardType: 'High Waves', severity: 'Medium', details: '', lat: null, lon: null });
  const [geoMsg, setGeoMsg] = useState('');

  /* ----- auth + reports ----- */
  useEffect(() => {
    (async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) await signInWithCustomToken(auth, __initial_auth_token);
        else await signInAnonymously(auth);
      } catch (e) { console.error('Authentication failed:', e); }
    })();
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user) return;
    const ref = collection(db, 'artifacts', appId, 'public', 'data', 'hazard_reports');
    return onSnapshot(ref, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      list.sort((a, b) => b.timestamp - a.timestamp);
      setReports(list);
      setLoadingReports(false);
    }, (e) => { console.error(e); setLoadingReports(false); });
  }, [user]);

  /* ----- live conditions ----- */
  const load = useCallback(async (p) => {
    setLoadingCond(true); setCondError('');
    try { setCond(await fetchConditions(p.latitude, p.longitude)); }
    catch (e) { setCond(null); setCondError(e.message || 'Could not load conditions.'); }
    finally { setLoadingCond(false); }
  }, []);

  useEffect(() => {
    load(place);
    const t = setInterval(() => load(place), REFRESH_MS);
    return () => clearInterval(t);
  }, [place, load]);

  const searchPlaces = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true); setResults([]);
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=6&language=en&format=json`);
      const j = await r.json();
      setResults(j.results || []);
      if (!j.results?.length) setCondError('No matching place found. Try a nearby town or beach name.');
    } catch { setCondError('Place search failed. Check your connection.'); }
    finally { setSearching(false); }
  };

  const pickPlace = (p) => {
    setPlace(p); setResults([]); setQuery('');
    setForm((f) => ({ ...f, location: [p.name, p.admin1].filter(Boolean).join(', '), lat: p.latitude, lon: p.longitude }));
  };

  /* ----- current location for the report form ----- */
  const useMyLocation = () => {
    if (!navigator.geolocation) { setGeoMsg('Your browser does not support location access.'); return; }
    setGeoMsg('Finding your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      let name = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
        const j = await r.json();
        const label = [j.locality || j.city, j.principalSubdivision].filter(Boolean).join(', ');
        if (label) name = label;
      } catch { /* keep coordinates */ }
      setForm((f) => ({ ...f, location: name, lat: latitude, lon: longitude }));
      setGeoMsg('Location added to your report.');
    }, (err) => setGeoMsg(err.code === 1 ? 'Location permission was denied. Type the place instead.' : 'Could not get your location.'),
    { enableHighAccuracy: true, timeout: 10000 });
  };

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!user || !form.location || !form.details) return;
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'hazard_reports'), { ...form, userId: user.uid, timestamp: Date.now() });
      setForm((f) => ({ ...f, details: '', location: '', lat: null, lon: null }));
      setGeoMsg('Report submitted. Thank you.');
    } catch (err) { console.error(err); setGeoMsg('Could not submit the report. Try again.'); }
    finally { setSubmitting(false); }
  };

  /* ----- status: live data, raised by recent community reports near the same place name ----- */
  const live = assess(cond);
  const recent = reports.filter((r) => Date.now() - r.timestamp < 24 * 3600 * 1000);
  const communityHigh = recent.filter((r) => r.severity === 'High').length;
  let status = live;
  if (communityHigh && live.tone === 'safe') {
    status = { level: 'WARNING', tone: 'warn', text: `${communityHigh} high-severity community report${communityHigh > 1 ? 's' : ''} in the last 24 hours`, reasons: live.reasons };
  }
  const tone = TONES[status.tone];
  const StatusIcon = tone.Icon;

  const hazardCounts = Object.entries(recent.reduce((a, r) => ({ ...a, [r.hazardType]: (a[r.hazardType] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  const c = cond?.marine; const w = cond?.wind;
  const fmtTime = (ts) => new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200" style={{ fontFamily: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif' }}>
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Waves className="text-cyan-400" size={22} />
            <span className="text-lg font-semibold text-slate-50 tracking-tight">Ocean Alert</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-400">
            <span className="hidden sm:flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />Live data, refreshes every 10 min</span>
            <a href={INCOIS_ALERTS_PAGE} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300">INCOIS alerts <ExternalLink size={12} /></a>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Search */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 sm:p-5">
          <form onSubmit={searchPlaces} className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Enter a coastal area, e.g. Kovalam, Marina Beach, Puri" className={`${inputCls} pl-9`} aria-label="Coastal area" />
            </div>
            <button type="submit" disabled={searching} className="rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium px-5 py-2.5 text-sm disabled:opacity-60">
              {searching ? 'Searching…' : 'Check conditions'}
            </button>
          </form>
          {results.length > 0 && (
            <ul className="mt-3 divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
              {results.map((p) => (
                <li key={p.id}>
                  <button onClick={() => pickPlace(p)} className="w-full text-left px-4 py-2.5 text-sm hover:bg-slate-800 flex items-center gap-2">
                    <MapPin size={14} className="text-cyan-400 shrink-0" />
                    <span className="text-slate-100">{p.name}</span>
                    <span className="text-slate-500">{[p.admin1, p.country].filter(Boolean).join(', ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Status */}
        <section className={`rounded-2xl border ${tone.ring} bg-gradient-to-r ${tone.bar} bg-slate-900/60 p-5 sm:p-6`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
            <div className="flex items-center gap-4">
              <StatusIcon size={40} className={tone.text} />
              <div>
                <div className="text-sm text-slate-400 flex items-center gap-1.5"><MapPin size={14} />{[place.name, place.admin1].filter(Boolean).join(', ')}</div>
                <div className={`text-3xl font-bold ${tone.text}`}>{status.level}</div>
                <p className="text-slate-300 text-sm mt-0.5 max-w-xl">{status.text}</p>
                {status.reasons.length > 0 && <p className="text-xs text-slate-500 mt-1">{status.reasons.join(' · ')}</p>}
              </div>
            </div>
            <button onClick={() => load(place)} className="self-start sm:self-center flex items-center gap-2 text-sm rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2">
              <RefreshCw size={14} className={loadingCond ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: live data */}
          <div className="lg:col-span-5 space-y-6">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <h2 className="font-semibold text-slate-50">Ocean conditions now</h2>
                <span className="text-xs text-slate-500">{cond?.updated ? `Model time ${cond.updated.replace('T', ' ')}` : ''}</span>
              </div>
              <div className="p-5">
                {loadingCond && !cond && <p className="text-slate-500 text-sm">Loading live data…</p>}
                {condError && <p className="text-amber-300 text-sm">{condError}</p>}
                {c && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Stat icon={Waves} label="Wave height" value={fmt(c.wave_height, ' m')} sub={`Period ${fmt(c.wave_period, ' s', 0)} · from ${compass(c.wave_direction)}`} />
                      <Stat icon={Waves} label="Swell" value={fmt(c.swell_wave_height, ' m')} sub={`Period ${fmt(c.swell_wave_period, ' s', 0)}`} />
                      <Stat icon={Wind} label="Wind" value={fmt(w?.wind_speed_10m, ' km/h', 0)} sub={`Gusts ${fmt(w?.wind_gusts_10m, '', 0)} · from ${compass(w?.wind_direction_10m)}`} />
                      <Stat icon={Thermometer} label="Sea temperature" value={fmt(c.sea_surface_temperature, ' °C')} />
                      <Stat icon={Navigation} label="Surface current" value={fmt(c.ocean_current_velocity, ' km/h')} sub={`Toward ${compass(c.ocean_current_direction)}`} />
                      <Stat icon={ArrowUpDown} label="Sea level" value={fmt(c.sea_level_height_msl, ' m', 2)} sub="Relative to mean, incl. tide" />
                    </div>
                    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                      <div className="text-xs text-slate-400 mb-1">Wave height, next 6 hours</div>
                      <Sparkline values={cond.trend} />
                      <div className="flex justify-between text-xs text-slate-500"><span>{fmt(cond.trend[0], ' m')}</span><span>{fmt(cond.trend[cond.trend.length - 1], ' m')}</span></div>
                    </div>
                  </>
                )}
              </div>
              <div className="px-5 py-3 border-t border-slate-800 text-xs text-slate-500">
                Source: Open-Meteo Marine and Weather APIs (model data for the nearest ocean grid point).
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
              <h2 className="font-semibold text-slate-50 flex items-center gap-2"><Compass size={18} className="text-cyan-400" />Official INCOIS alerts</h2>
              <p className="text-sm text-slate-400 mt-2">High wave, swell surge, current and tsunami alerts for your coast are issued by INCOIS. Check them before you go near the water.</p>
              <div className="flex flex-wrap gap-2 mt-3">
                <a className="text-sm rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 flex items-center gap-1.5" href={INCOIS_ALERTS_PAGE} target="_blank" rel="noreferrer">Alert map <ExternalLink size={13} /></a>
                <a className="text-sm rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 flex items-center gap-1.5" href={INCOIS_OSF_PAGE} target="_blank" rel="noreferrer">Ocean state forecast <ExternalLink size={13} /></a>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
              <h2 className="font-semibold text-slate-50">Reported in the last 24 hours</h2>
              {hazardCounts.length === 0 ? (
                <p className="text-sm text-slate-500 mt-2">No community reports yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {hazardCounts.map(([type, n]) => (
                    <li key={type} className="flex items-center gap-3 text-sm">
                      <span className="w-36 text-slate-300">{type}</span>
                      <div className="flex-1 h-2 rounded bg-slate-800"><div className="h-2 rounded bg-cyan-400" style={{ width: `${(n / hazardCounts[0][1]) * 100}%` }} /></div>
                      <span className="tabular-nums text-slate-400 w-6 text-right">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Right: report + feed */}
          <div className="lg:col-span-7 space-y-6">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="font-semibold text-slate-50 flex items-center gap-2"><AlertTriangle size={18} className="text-amber-400" />Submit hazard report</h2>
                <p className="text-xs text-slate-500 mt-1">Tell others what you see on the coast right now.</p>
              </div>
              <form onSubmit={submit} className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-slate-300 mb-1 block" htmlFor="location">Location</label>
                    <div className="flex gap-2">
                      <input id="location" name="location" value={form.location} onChange={onChange} required placeholder="Marina Beach, Chennai" className={inputCls} />
                      <button type="button" onClick={useMyLocation} title="Use my current location" aria-label="Use my current location" className="shrink-0 rounded-lg border border-slate-700 hover:bg-slate-800 hover:border-cyan-400 px-3 text-cyan-400"><LocateFixed size={18} /></button>
                    </div>
                    {geoMsg && <p className="text-xs text-slate-400 mt-1.5">{geoMsg}</p>}
                  </div>
                  <div>
                    <label className="text-sm text-slate-300 mb-1 block" htmlFor="hazardType">Hazard type</label>
                    <select id="hazardType" name="hazardType" value={form.hazardType} onChange={onChange} className={inputCls}>
                      {['High Waves', 'Coastal Erosion', 'Jellyfish Bloom', 'Storm Surge', 'Strong Currents', 'Other'].map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                </div>

                <fieldset>
                  <legend className="text-sm text-slate-300 mb-1">Severity</legend>
                  <div className="flex gap-2">
                    {['Low', 'Medium', 'High'].map((lvl) => (
                      <label key={lvl} className={`cursor-pointer text-sm px-4 py-1.5 rounded-lg border ${form.severity === lvl ? sevChip(lvl) + ' ring-1 ring-current' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                        <input type="radio" name="severity" value={lvl} checked={form.severity === lvl} onChange={onChange} className="sr-only" />{lvl}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div>
                  <label className="text-sm text-slate-300 mb-1 block" htmlFor="details">What do you see?</label>
                  <textarea id="details" name="details" rows={3} value={form.details} onChange={onChange} required placeholder="Describe the conditions and who is affected" className={inputCls} />
                </div>

                <button type="submit" disabled={submitting || !user} className="w-full flex items-center justify-center gap-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium py-2.5 text-sm disabled:opacity-50">
                  <Send size={15} />{submitting ? 'Submitting…' : 'Submit report'}
                </button>
                {!user && <p className="text-xs text-amber-300 text-center">Connecting to the service…</p>}
              </form>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/50 flex flex-col h-[480px]">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <h2 className="font-semibold text-slate-50 flex items-center gap-2"><Clock size={18} className="text-slate-400" />Community reports</h2>
                <span className="text-xs text-cyan-300 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />Updates live</span>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {loadingReports ? <p className="text-slate-500 text-sm">Loading reports…</p>
                  : reports.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center">
                      <ShieldCheck size={44} className="mb-2 opacity-40" />
                      <p>No hazards reported yet.</p><p className="text-sm">Be the first to report what you see.</p>
                    </div>
                  ) : reports.map((r) => (
                    <article key={r.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                      <div className="flex justify-between items-start gap-3">
                        <div>
                          <span className={`inline-block text-xs px-2 py-0.5 rounded border ${sevChip(r.severity)}`}>{r.severity} severity</span>
                          <h3 className="font-semibold text-slate-100 text-sm mt-1.5">{r.hazardType}</h3>
                        </div>
                        <time className="text-xs text-slate-500 whitespace-nowrap">{fmtTime(r.timestamp)}</time>
                      </div>
                      <p className="text-sm text-slate-300 mt-2">{r.details}</p>
                      <div className="flex items-center text-xs text-slate-500 mt-3">
                        <MapPin size={12} className="mr-1" />{r.location}
                        {r.lat != null && <span className="ml-2 text-slate-600">({Number(r.lat).toFixed(3)}, {Number(r.lon).toFixed(3)})</span>}
                        <span className="ml-auto">Reporter {r.userId?.substring(0, 6)}</span>
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          </div>
        </div>

        <p className="text-xs text-slate-600 text-center pb-4">
          Ocean Alert shows model-based data for awareness only. For official warnings, follow INCOIS and your local disaster management authority.
        </p>
      </main>
    </div>
  );
}
