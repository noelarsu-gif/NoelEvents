// NoelEvents · avisos automáticos (lo ejecuta GitHub Actions)
// MODO=semana  -> resumen de los eventos de lunes a domingo
// MODO=manana  -> recordatorio de los eventos de mañana
// MODO=tareas  -> cada mañana: tareas sin hacer de la semana antes del evento + recordatorio del álbum
// MODO=prueba  -> envía el resumen de los próximos eventos aunque no sean de esta semana
import admin from "firebase-admin";
import nodemailer from "nodemailer";
import { JWT } from "google-auth-library";

const MODO = process.env.MODO || "prueba";
const APP = process.env.APP_URL || "";
let TO = (process.env.DESTINATARIOS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("Falta el secreto FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
// Destinatarios: las cuentas que han entrado en la app (colección "usuarios"), así no hay correos en el código
if (!TO.length) TO = [...new Set((await db.collection("usuarios").get()).docs.map(d => String(d.data().email || "").trim()).filter(Boolean))];

/* ---------- Fechas en hora de Madrid ---------- */
const hoyMadrid = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date()); // AAAA-MM-DD
const sumar = (iso, d) => { const t = new Date(iso + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fecha = iso => { const t = new Date(iso + "T12:00:00Z"); return `${DIAS[t.getUTCDay()]} ${t.getUTCDate()} de ${MESES[t.getUTCMonth()]}`; };
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };
const eur = x => Math.round(x).toLocaleString("es-ES", { useGrouping: "always" }) + " €";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const total = e => (e.servicios || []).reduce((a, s) => a + num(s.precio), 0) + num(e.desplazamiento);
const pagado = e => (e.pagos || []).reduce((a, p) => a + num(p.importe), 0);
const pick = a => a[Math.floor(Math.random() * a.length)];

/* ---------- Eventos recién cerrados: push "¡otro evento cerrado!" ---------- */
// Solo eventos creados en la app a partir de que existe este aviso (no los importados)
const NUEVOS_DESDE = "2026-11-10T13:45:00Z";
async function avisarNuevos(){
  const q = await db.collection("events").where("creado", ">=", NUEVOS_DESDE).get();
  const nuevos = q.docs.filter(d => { const e = d.data(); return !e.pushNuevo && e.estado === "reservada"; });
  if (!nuevos.length) { console.log("Nuevos: nada."); return; }
  const tokens = (await db.collection("push").get()).docs.map(d => d.id);
  const EMO = { boda: ["💍", "🎉", "🥂", "💃", "✨"], fiesta: ["🪩", "🎈", "🔥", "🕺", "🎶"], empresa: ["🥂", "🎤", "✨", "🎶"], "cumpleaños": ["🎂", "🎈", "🎉", "🥳"], otro: ["🎧", "🎶", "✨"] };
  const TIT = [
    t => `${t[0]} ¡Otro evento cerrado! ${t[1]}`,
    t => `${t[0]} ¡Boom! Fecha reservada ${t[1]}`,
    t => `${t[0]} ¡Una más para la colección! ${t[1]}`,
    t => `${t[0]} ¡Sí, quiero… otra reserva! ${t[1]}`,
    t => `${t[0]} ¡Se viene fiestón! ${t[1]}`,
    t => `${t[0]} ¡Otra pista de baile que llenar! ${t[1]}`,
    t => `${t[0]} ¡Esto no para! ${t[1]}`,
    t => `${t[0]} ¡Reserva en el bote! ${t[1]}`,
    t => `${t[0]} ¡Hoy se celebra! Nueva fecha ${t[1]}`,
    t => `${t[0]} ¡Más madera! Otra boda cerrada ${t[1]}`,
    t => `${t[0]} ¡Toma ya! Nueva reserva ${t[1]}`,
    t => `${t[0]} ¡La agenda echa humo! ${t[1]}`,
    t => `${t[0]} ¡Chin chin, cerramos otra! ${t[1]}`,
    t => `${t[0]} ¡Que suene la música! Nueva reserva ${t[1]}`
  ];
  for (const d of nuevos) {
    const e = d.data(), tipo = (e.tipo || "boda").toLowerCase(), em = EMO[tipo] || EMO.otro;
    const a1 = pick(em), a2 = pick(em.filter(x => x !== a1)) || a1;
    const titulo = pick(TIT)([a1, a2]);
    const por = e.creadoPor ? `${e.creadoPor} ha cerrado ` : "";
    const cuerpo = `${por}${e.novios} · ${fecha(e.fecha)}${e.lugar ? " · " + e.lugar : ""}`;
    const url = APP + "#evento-" + encodeURIComponent(d.id);
    if (tokens.length) {
      const r = await admin.messaging().sendEachForMulticast({ tokens, webpush: { notification: { title: titulo, body: cuerpo, icon: APP + "icons/icon-192.png", badge: APP + "icons/icon-192.png", tag: "nuevo-" + d.id }, fcmOptions: { link: url } }, data: { url } });
      console.log(`Nuevo "${e.novios}": ${r.successCount} push enviadas, ${r.failureCount} fallidas`);
      await Promise.all(r.responses.map((x, i) => !x.success && /registration-token-not-registered|invalid-argument/.test(x.error?.code || "") ? db.collection("push").doc(tokens[i]).delete() : null));
    } else console.log(`Nuevo "${e.novios}": ningún móvil con push activado.`);
    await d.ref.update({ pushNuevo: true });
  }
}

/* ---------- Sincronización con Google Calendar ---------- */
async function syncCalendario(){
  const CAL = process.env.CALENDAR_ID; if (!CAL) { console.log("Calendario: falta el secreto CALENDAR_ID."); return; }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/calendar"] });
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`;
  const api = async (method, url, body) => { const r = await jwt.request({ method, url, data: body, validateStatus: () => true }); return r; };
  const gid = id => "ne" + Buffer.from(id).toString("hex");
  const desde = sumar(hoyMadrid(), -30);
  const docs = (await db.collection("events").get()).docs;
  const activos = new Set(); let creados = 0, cambiados = 0, borrados = 0;
  for (const d of docs) {
    const e = d.data(); if (!e.fecha || e.fecha < desde) continue;
    if (!["reservada", "derivada"].includes(e.estado)) continue;
    const id = gid(d.id); activos.add(id);
    const h = e.horario || {}, ini = h.montaje || h.inicio, sig = sumar(e.fecha, 1);
    let start, end;
    if (ini) { start = { dateTime: `${e.fecha}T${ini}:00`, timeZone: "Europe/Madrid" };
      const fin = h.fin || null; end = fin ? { dateTime: `${fin < ini ? sig : e.fecha}T${fin}:00`, timeZone: "Europe/Madrid" }
        : { dateTime: new Date(new Date(`${e.fecha}T${ini}:00Z`).getTime() + 9 * 3600e3).toISOString().slice(0, 19), timeZone: "Europe/Madrid" }; }
    else { start = { date: e.fecha }; end = { date: sig }; }
    const pend = Math.max(0, total(e) - pagado(e)), c = e.costes || {};
    const desc = [
      (e.servicios || []).map(s => s.nombre).filter(Boolean).join(", ") && "🎛️ " + (e.servicios || []).map(s => s.nombre).filter(Boolean).join(", "),
      [h.montaje && `Montaje ${h.montaje}`, h.ceremonia && `Ceremonia ${h.ceremonia}`, h.inicio && `Inicio ${h.inicio}`, h.fin && `Fin ${h.fin}`].filter(Boolean).join(" · ") && "🕓 " + [h.montaje && `Montaje ${h.montaje}`, h.ceremonia && `Ceremonia ${h.ceremonia}`, h.inicio && `Inicio ${h.inicio}`, h.fin && `Fin ${h.fin}`].filter(Boolean).join(" · "),
      (e.contacto || e.telefono) && "☎️ " + [e.contacto, e.telefono].filter(Boolean).join(" · "),
      c.ayudanteNombre && "🤝 Ayudante: " + c.ayudanteNombre,
      e.estado === "derivada" ? `↪️ Derivada a ${(e.derivacion || {}).companero || "compañero"}` : (pend ? `💰 Pendiente: ${eur(pend)}` : "✅ Cobrado"),
      e.notasEquipo && "\n" + e.notasEquipo,
      APP && "\nAbrir en NoelEvents: " + APP + "#evento-" + encodeURIComponent(d.id)
    ].filter(Boolean).join("\n");
    const body = { id, summary: `${e.estado === "derivada" ? "↪️ " : ""}${({ boda: "💍", fiesta: "🪩", empresa: "🥂", "cumpleaños": "🎂" })[e.tipo] || "🎧"} ${e.novios}`, location: e.lugar || "", description: desc, start, end,
      colorId: e.estado === "derivada" ? "8" : (pagado(e) > 0 ? "10" : "6"),
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 180 }] },
      extendedProperties: { private: { ne: "1" } } };
    const hash = Buffer.from(JSON.stringify(body)).toString("base64").slice(0, 60) + JSON.stringify(body).length;
    if (e.gcalHash === hash) continue;
    let r = await api("PUT", `${base}/${id}`, body);
    if (r.status === 404) { r = await api("POST", base, body); if (r.status < 300) creados++; }
    else if (r.status < 300) cambiados++;
    if (r.status >= 300) { const msg = JSON.stringify(r.data).slice(0, 300); console.log("Calendario: error", r.status, msg);
      if (r.status === 403 || r.status === 401 || r.status === 404) { console.log("Calendario: paro la sincronización hasta que se resuelva."); return; } continue; }
    await d.ref.update({ gcalHash: hash });
  }
  // Borrar del calendario lo que ya no existe, se ha cancelado o es propuesta
  let token = "";
  do {
    const r = await api("GET", `${base}?privateExtendedProperty=ne%3D1&timeMin=${desde}T00:00:00Z&maxResults=250&showDeleted=false${token ? "&pageToken=" + token : ""}`);
    if (r.status >= 300) { console.log("Calendario: no se puede leer", r.status, JSON.stringify(r.data).slice(0, 300)); break; }
    for (const ev of r.data.items || []) if (!activos.has(ev.id)) { const x = await api("DELETE", `${base}/${ev.id}`); if (x.status < 300) borrados++; }
    token = r.data.nextPageToken || "";
  } while (token);
  // Los borrados deben volver a crearse si reaparecen: limpiar la marca de los que ya no están
  await Promise.all(docs.filter(d => d.data().gcalHash && !activos.has(gid(d.id))).map(d => d.ref.update({ gcalHash: admin.firestore.FieldValue.delete() })));
  console.log(`Calendario: ${creados} creados, ${cambiados} actualizados, ${borrados} borrados.`);
}
if (MODO === "calendario") { await syncCalendario(); process.exit(0); }

/* ---------- Envío común ---------- */
const mailer = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD ? nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") } }) : null;
let _tokens = null;
async function push(title, body, url, tag){
  if (!_tokens) _tokens = (await db.collection("push").get()).docs.map(d => d.id);
  if (!_tokens.length) { console.log("Push: ningún móvil activado."); return; }
  const r = await admin.messaging().sendEachForMulticast({ tokens: _tokens, webpush: { notification: { title, body, icon: APP + "icons/icon-192.png", badge: APP + "icons/icon-192.png", ...(tag ? { tag } : {}) }, fcmOptions: { link: url || APP } }, data: { url: url || APP } });
  console.log(`Push "${title}": ${r.successCount} enviadas, ${r.failureCount} fallidas`);
  await Promise.all(r.responses.map((x, i) => !x.success && /registration-token-not-registered|invalid-argument/.test(x.error?.code || "") ? db.collection("push").doc(_tokens[i]).delete() : null));
}
const linkEv = id => APP + "#evento-" + encodeURIComponent(id);
const faltan = n => n === 0 ? "hoy" : n === 1 ? "mañana" : `en ${n} días`;
const diasHasta = f => Math.round((new Date(f + "T12:00:00Z") - new Date(hoyMadrid() + "T12:00:00Z")) / 864e5);

/* ---------- Fotomatón → tarea "Comprar el álbum" (una vez por evento) ---------- */
const ALBUM_TXT = "Comprar el álbum del fotomatón";
const llevaFoto = e => (e.servicios || []).some(s => /fotomat|photo|complet/i.test(s.nombre || ""));
const esAlbum = t => /[áa]lbum/i.test(t.texto || "");
async function albumTareas(){
  const hoy = hoyMadrid(); let n = 0;
  for (const d of (await db.collection("events").where("fecha", ">=", hoy).get()).docs) {
    const e = d.data(); if (e.albumAuto || e.estado !== "reservada" || !llevaFoto(e)) continue;
    const tareas = e.tareas || []; if (!tareas.some(esAlbum)) tareas.push({ texto: ALBUM_TXT, hecha: false });
    await d.ref.update({ tareas, albumAuto: true }); n++;
  }
  if (n) console.log(`Álbum: tarea añadida a ${n} evento(s).`);
}

/* ---------- Textos simpáticos (muchos, para que nunca se repitan) ---------- */
const T_TAREAS = [
  (e, n) => `📝 ${e.novios}: te queda${n > 1 ? "n" : ""} ${n} cosita${n > 1 ? "s" : ""}`,
  (e, n, d) => `⏳ ${e.novios} es ${faltan(d)} y hay deberes`,
  (e) => `🧠 Recordatorio con cariño: ${e.novios}`,
  (e, n, d) => `🎯 Cuenta atrás ${e.novios}: ${d === 0 ? "¡es hoy!" : d === 1 ? "¡mañana!" : d + " días"}`,
  (e) => `✅ Que no se escape nada · ${e.novios}`,
  (e) => `🕵️ He encontrado tareas sueltas de ${e.novios}`,
  (e, n) => `📋 ${n > 1 ? n + " tareas" : "Una tarea"} esperando por ti · ${e.novios}`,
  (e) => `☕ Café y a tachar cosas: ${e.novios}`,
  (e, n, d) => `🚦 ${e.novios} ${faltan(d)}: semáforo en ámbar`,
  (e) => `🎧 Antes de poner música, esto: ${e.novios}`,
  (e) => `💪 Un empujón y lo tienes · ${e.novios}`,
  (e, n, d) => `📅 Faltan ${d} días para ${e.novios} y la lista no está a cero`,
  (e) => `🔔 Toc, toc… tareas de ${e.novios}`,
  (e) => `🧩 Te faltan piezas del puzzle de ${e.novios}`,
  (e) => `🪩 Para que la fiesta de ${e.novios} salga redonda…`,
  (e, n) => `✍️ ${n} ${n > 1 ? "pendientes" : "pendiente"} en ${e.novios}. ¿Lo tachamos hoy?`,
  (e) => `🚀 Modo productivo: ${e.novios}`,
  (e) => `🙈 No me hagas repetirlo mañana… ${e.novios}`,
  (e, n, d) => `⏰ ${d <= 1 ? "¡Última llamada!" : "Ojo al dato"} · ${e.novios}`,
  (e) => `🎁 Pequeños detalles, grandes bodas · ${e.novios}`
];
const T_TAREAS_PIE = ["Toca para abrir el evento y marcarla como hecha ✔️", "Márcala en la app y te dejo en paz 😇", "Cuando esté hecha, un toque en la casilla y listo.", "Mañana te lo vuelvo a recordar si sigue pendiente 😉", "Tachar cosas sienta de maravilla ✨"];
const T_ALBUM = [
  e => `📖 ¡Álbum a la vista! ${e.novios} en una semana`,
  e => `🛒 Hora de comprar el álbum de ${e.novios}`,
  e => `📸 Sin álbum no hay firmas · ${e.novios}`,
  e => `✍️ Que los invitados de ${e.novios} tengan dónde firmar`,
  e => `📚 Misión álbum: ${e.novios}`,
  e => `🎀 El álbum de ${e.novios} te está esperando en la tienda`,
  e => `🧾 Lista de la compra: un álbum para ${e.novios}`,
  e => `💌 Recuerdos con firma: compra el álbum de ${e.novios}`,
  e => `🏃 Corre, que el álbum de ${e.novios} no se compra solo`,
  e => `📷 Fotomatón listo, ¿y el álbum? · ${e.novios}`,
  e => `🥂 Una semana para ${e.novios}: falta el álbum`,
  e => `⭐ Detallazo pendiente: el álbum de ${e.novios}`
];
const T_ALBUM_INTRO = [
  "Dentro de una semana hay fotomatón y los invitados van a querer pegar fotos y dejar mensajes. Solo falta un detalle:",
  "Te lo apunto antes de que se cuele entre canción y canción:",
  "Lo bonito del fotomatón es lo que queda después. Y para eso hace falta…",
  "Repaso rápido de material para la boda de la semana que viene:",
  "Un aviso de tu secretaria favorita 😇:",
  "Para que el día de la boda no toque improvisar:"
];
const T_ALBUM_CIERRE = ["¡Que se llene de firmas! ✍️", "Recuerdos para toda la vida 📖", "Un detalle que los novios no olvidan ✨", "¡A por ese álbum! 🛒", "Fotos, risas y dedicatorias 📸"];

/* ---------- Modo tareas (cada mañana) ---------- */
if (MODO === "tareas") {
  await albumTareas();
  const hoy = hoyMadrid(), hasta = sumar(hoy, 7);
  const docs = (await db.collection("events").where("fecha", ">=", hoy).where("fecha", "<=", hasta).get()).docs.filter(d => d.data().estado === "reservada");
  console.log(`Tareas: ${docs.length} evento(s) en los próximos 7 días.`);
  for (const d of docs) {
    const e = d.data(), dd = diasHasta(e.fecha), url = linkEv(d.id);
    const pend = (e.tareas || []).filter(t => !t.hecha && String(t.texto || "").trim());
    const album = pend.find(esAlbum);
    let resto = pend;
    // Álbum: aviso especial (push + email) la primera vez que entra en la última semana
    if (album && !e.albumMail) {
      const tit = pick(T_ALBUM)(e), intro = pick(T_ALBUM_INTRO), cierre = pick(T_ALBUM_CIERRE);
      await push(tit, `${album.texto} · ${fecha(e.fecha)}${e.lugar ? " · " + e.lugar : ""}`, url, "album-" + d.id);
      if (mailer && TO.length) {
        await mailer.sendMail({ from: `"NoelEvents" <${process.env.GMAIL_USER}>`, to: TO.join(","), subject: tit,
          text: `${tit}\n\n${intro}\n\n📖 ${album.texto}\n${e.novios} · ${fecha(e.fecha)}${e.lugar ? " · " + e.lugar : ""}\n\n${cierre}\n${url}`,
          html: `<div style="background:#0B0A08;color:#F3EEE4;font-family:Helvetica,Arial,sans-serif;padding:28px 18px"><div style="max-width:560px;margin:0 auto">
            <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A961;font-weight:bold">Noel DJ · Music &amp; Events</div>
            <div style="font-family:Georgia,serif;font-size:28px;line-height:1.2;margin:10px 0 14px">${esc(tit)}</div>
            <p style="font-size:15px;line-height:1.6;color:#D8D2C6">${esc(intro)}</p>
            <div style="border:1px solid #3A342A;padding:18px 20px;margin:16px 0">
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#C9A961;font-weight:bold">${esc(fecha(e.fecha))} · ${faltan(dd)}</div>
              <div style="font-family:Georgia,serif;font-size:24px;margin:6px 0 10px">${esc(e.novios)}</div>
              <div style="font-size:15px;line-height:1.7">📖 ${esc(album.texto)}</div>
              ${e.lugar ? `<div style="font-size:14px;line-height:1.7;color:#B9B2A6">📍 ${esc(e.lugar)}</div>` : ""}
            </div>
            <div style="font-family:Georgia,serif;font-style:italic;font-size:20px;color:#C9A961;padding:6px 0 18px">${esc(cierre)}</div>
            ${APP ? `<a href="${url}" style="display:inline-block;background:#C9A961;color:#1A140A;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding:14px 22px">Abrir el evento</a>` : ""}
          </div></div>` });
        console.log(`Álbum: email enviado (${e.novios}).`);
      }
      await d.ref.update({ albumMail: true });
      resto = pend.filter(t => t !== album);
    }
    if (!resto.length) continue;
    const tit = pick(T_TAREAS)(e, resto.length, dd);
    const lista = resto.slice(0, 4).map(t => "• " + t.texto).join("\n") + (resto.length > 4 ? `\n…y ${resto.length - 4} más` : "");
    await push(tit, `${lista}\n${pick(T_TAREAS_PIE)}`, url, "tareas-" + d.id);
  }
  process.exit(0);
}

/* ---------- Modo seguridad: aviso de sesiones bloqueadas (y eventos nuevos) ---------- */
if (MODO === "seguridad") {
  await avisarNuevos();
  try { await albumTareas(); } catch (err) { console.log("Álbum: fallo", err.message); }
  try { await syncCalendario(); } catch (err) { console.log("Calendario: fallo", err.message); }
  const q = await db.collection("seguridad").where("avisado", "==", false).get();
  if (q.empty) { console.log("Seguridad: nada nuevo."); process.exit(0); }
  const tokens = (await db.collection("push").get()).docs.map(d => d.id);
  for (const d of q.docs) {
    const x = d.data(); const hora = new Date(x.cuando || Date.now()).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "full", timeStyle: "short" });
    const quien = x.nombre || "una cuenta", por = x.por || "alguien";
    const titulo = `🔒 Sesión de ${quien} bloqueada en NoelEvents`;
    const cuerpo = `${por} ha cerrado la sesión de ${quien} en todos sus dispositivos el ${hora}. Los móviles con esa sesión ya no pueden ver nada y borrarán sus datos al conectarse. Para volver a usar la app hay que entrar de nuevo.`;
    if (mailer && TO.length) await mailer.sendMail({ from: `"NoelEvents" <${process.env.GMAIL_USER}>`, to: TO.join(","), subject: titulo, text: cuerpo + "\n\nSi no habéis sido vosotros, cambiad la contraseña cuanto antes.\n" + APP,
      html: `<div style="background:#0B0A08;color:#F3EEE4;font-family:Helvetica,Arial,sans-serif;padding:28px"><div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#E08A7E;font-weight:bold">Seguridad</div><div style="font-family:Georgia,serif;font-size:26px;margin:10px 0 14px">${esc(titulo)}</div><p style="font-size:15px;line-height:1.6;color:#D8D2C6">${esc(cuerpo)}</p><p style="font-size:13px;line-height:1.6;color:#E8B27A">Si no habéis sido vosotros, cambiad la contraseña cuanto antes.</p>${APP ? `<a href="${APP}" style="display:inline-block;background:#C9A961;color:#1A140A;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding:14px 22px">Abrir NoelEvents</a>` : ""}</div>` });
    if (tokens.length) await admin.messaging().sendEachForMulticast({ tokens, webpush: { notification: { title: titulo, body: `${por} ha cerrado la sesión de ${quien}.`, icon: APP + "icons/icon-192.png" }, fcmOptions: { link: APP } }, data: { url: APP } }).catch(() => {});
    await d.ref.update({ avisado: true });
    console.log("Aviso de seguridad enviado:", quien);
  }
  process.exit(0);
}

/* ---------- Datos ---------- */
const hoy = hoyMadrid();
let desde = hoy, hasta = hoy;
if (MODO === "semana") hasta = sumar(hoy, 6);
else if (MODO === "manana") desde = hasta = sumar(hoy, 1);
else hasta = sumar(hoy, 60);

const snap = await db.collection("events").get();
let eventos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  .filter(e => e.fecha && e.fecha >= desde && e.fecha <= hasta && e.estado === "reservada")
  .sort((a, b) => (a.fecha + (a.horario?.inicio || "")).localeCompare(b.fecha + (b.horario?.inicio || "")));
if (MODO === "prueba") eventos = eventos.slice(0, 3);

console.log(`Modo ${MODO}: ${desde} → ${hasta}, ${eventos.length} evento(s)`);
if (!eventos.length) { console.log("Nada que avisar."); process.exit(0); }

/* ---------- Textos ---------- */
const uno = eventos.length === 1, e0 = eventos[0];
const TITULOS = {
  semana: uno ? [`¡Semana de fiesta! 🎧 ${e0.novios} te espera`, `Esta semana hay música: ${e0.novios} 🎶`, `Se viene un buen sarao 🥂 ${e0.novios}`, `Esta semana se casa alguien… y tú pinchas 💍 ${e0.novios}`, `Marca el finde en rojo 🔴 ${e0.novios}`, `Lunes con planazo a la vista 🪩 ${e0.novios}`, `Semana de las buenas ✨ ${e0.novios}`, `Afina los cascos 🎧 ${e0.novios} está al caer`]
              : [`¡Semana movida! 🎧 ${eventos.length} eventos a la vista`, `${eventos.length} fiestas esta semana 🔥 ¡a por todas!`, `Agenda llena de baile 💃 ${eventos.length} eventos`, `Doblete (o más) esta semana 🏆 ${eventos.length} eventos`, `Semana de las intensas ⚡ ${eventos.length} eventos`, `Que no pare la música 🎶 ${eventos.length} eventos esta semana`, `Furgo cargada toda la semana 🚐 ${eventos.length} eventos`],
  manana: [`¡Mañana toca! 🎉 ${e0.novios}`, `Calienta motores 🚐 mañana ${e0.novios}`, `Prepara la cabina 🎛️ mañana ${e0.novios}`, `Cuenta atrás: 24 h para ${e0.novios} ⏳`, `Mañana se lía 🪩 ${e0.novios}`, `Carga baterías (y la furgo) 🔋 ${e0.novios}`, `Último ensayo mental 🧠 mañana ${e0.novios}`, `Mañana, a llenar la pista 💃 ${e0.novios}`, `El gran día es mañana 💍 ${e0.novios}`, `Duerme bien, que mañana hay fiesta 😴🎉 ${e0.novios}`],
  prueba: [`Prueba de avisos NoelEvents ✨`]
};
const INTROS = {
  semana: ["Lunes de café y planificación ☕ Esto es lo que suena esta semana:", "Nueva semana, nuevas pistas de baile llenas. Apunta:", "Se acerca el finde y hay faena de la buena:", "Tu secretaria te ha preparado el plan de la semana 😇:", "Para empezar la semana con todo bajo control:", "Esto es lo que te espera (y va a sonar de maravilla):", "Repaso semanal, sin sustos:"],
  manana: ["Mañana alguien se casa y tú pones la banda sonora. Repaso rápido:", "Último repaso antes del gran día:", "Que no se te olvide nada, que mañana es el día:", "Checklist de víspera, que mañana no hay tiempo:", "Mañana te toca brillar. Aquí tienes lo importante:", "Antes de dormir, un vistazo rápido:", "Todo lo que necesitas para mañana, en un momento:"],
  prueba: ["Si estás leyendo esto, los avisos funcionan. Así se verán tus próximos eventos:"]
};
const CIERRES = ["¡A darlo todo! 🕺", "¡Que retumbe la pista! 🔊", "Música, maestro 🎶", "¡A hacer historia en la pista! ✨", "¡Que nadie se quede sentado! 💃", "Hoy por ellos, mañana por la pista 🪩", "¡A por la mejor fiesta del año! 🏆", "Que suene fuerte y bonito 🎧", "Y que vivan los novios 🥂"];

const linea = e => {
  const h = e.horario || {}, pend = Math.max(0, total(e) - pagado(e)), c = e.costes || {};
  return {
    titulo: `${fecha(e.fecha)} · ${e.novios}`,
    lugar: e.lugar || "",
    horario: [h.montaje && `Montaje ${h.montaje}`, h.ceremonia && `Ceremonia ${h.ceremonia}`, h.inicio && `Inicio ${h.inicio}`, h.fin && `Fin ${h.fin}`].filter(Boolean).join(" · "),
    servicios: (e.servicios || []).map(s => s.nombre).filter(Boolean).join(", "),
    ayudante: c.ayudanteNombre || (num(c.ayudante) ? "con ayudante" : ""),
    pendiente: pend, notas: e.notasEquipo || "",
    tareas: (e.tareas || []).filter(t => !t.hecha).map(t => t.texto)
  };
};
const L = eventos.map(linea);
const titulo = pick(TITULOS[MODO] || TITULOS.semana), intro = pick(INTROS[MODO] || INTROS.semana), cierre = pick(CIERRES);

/* ---------- Email ---------- */
const html = `<!doctype html><html><body style="margin:0;background:#0B0A08;font-family:Helvetica,Arial,sans-serif;color:#F3EEE4">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B0A08"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px">
<tr><td style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#C9A961;font-weight:bold;padding-bottom:10px">Noel DJ · Music &amp; Events</td></tr>
<tr><td style="font-family:Georgia,serif;font-size:30px;line-height:1.2;padding-bottom:14px">${esc(titulo)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#D8D2C6;padding-bottom:18px">${esc(intro)}</td></tr>
${L.map(l => `<tr><td style="border:1px solid #3A342A;padding:18px 20px">
  <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#C9A961;font-weight:bold">${esc(l.titulo.split(" · ")[0])}</div>
  <div style="font-family:Georgia,serif;font-size:24px;margin:6px 0 10px">${esc(l.titulo.split(" · ").slice(1).join(" · "))}</div>
  ${l.lugar ? `<div style="font-size:14px;line-height:1.7">📍 ${esc(l.lugar)} · <a href="https://maps.google.com/?q=${encodeURIComponent(l.lugar)}" style="color:#C9A961">Ver en Maps</a></div>` : ""}
  ${l.horario ? `<div style="font-size:14px;line-height:1.7">🕓 ${esc(l.horario)}</div>` : `<div style="font-size:14px;line-height:1.7;color:#E8B27A">🕓 Horario sin apuntar</div>`}
  ${l.servicios ? `<div style="font-size:14px;line-height:1.7">🎛️ ${esc(l.servicios)}</div>` : ""}
  ${l.ayudante ? `<div style="font-size:14px;line-height:1.7">🤝 ${esc(l.ayudante)}</div>` : ""}
  ${l.pendiente ? `<div style="font-size:14px;line-height:1.7;color:#C9A961">💰 Quedan por cobrar ${eur(l.pendiente)}</div>` : `<div style="font-size:14px;line-height:1.7;color:#9FC4A0">✅ Cobrado</div>`}
  ${l.notas ? `<div style="font-size:13px;line-height:1.6;color:#B9B2A6;margin-top:8px;white-space:pre-wrap">${esc(l.notas)}</div>` : ""}
  ${l.tareas.length ? `<div style="font-size:13px;line-height:1.6;color:#E8B27A;margin-top:8px">Pendiente: ${l.tareas.map(esc).join(" · ")}</div>` : ""}
</td></tr><tr><td style="height:10px"></td></tr>`).join("")}
<tr><td style="font-family:Georgia,serif;font-style:italic;font-size:20px;color:#C9A961;padding:10px 0 18px">${esc(cierre)}</td></tr>
${APP ? `<tr><td><a href="${APP}" style="display:inline-block;background:#C9A961;color:#1A140A;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;padding:14px 22px">Abrir NoelEvents</a></td></tr>` : ""}
</table></td></tr></table></body></html>`;
const texto = [titulo, "", intro, "", ...L.map(l => [l.titulo, l.lugar && "📍 " + l.lugar, l.horario && "🕓 " + l.horario, l.servicios && "🎛️ " + l.servicios, l.pendiente ? "💰 Quedan " + eur(l.pendiente) : "✅ Cobrado", ""].filter(Boolean).join("\n")), cierre, APP].join("\n");

if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && TO.length) {
  const tr = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "") } });
  await tr.sendMail({ from: `"NoelEvents" <${process.env.GMAIL_USER}>`, to: TO.join(","), subject: titulo, text: texto, html });
  console.log(`Email enviado a ${TO.length} destinatario(s).`);
} else console.log("Email desactivado: faltan los secretos GMAIL_USER y GMAIL_APP_PASSWORD.");

/* ---------- Push ---------- */
const toks = await db.collection("push").get();
const tokens = toks.docs.map(d => d.id);
if (tokens.length) {
  const cuerpo = uno ? [L[0].lugar, L[0].horario].filter(Boolean).join(" · ") || L[0].servicios : L.map(l => l.titulo).join(" | ");
  const r = await admin.messaging().sendEachForMulticast({ tokens,
    webpush: { notification: { title: titulo, body: cuerpo, icon: APP + "icons/icon-192.png", badge: APP + "icons/icon-192.png" }, fcmOptions: { link: APP } },
    data: { url: APP } });
  console.log(`Push: ${r.successCount} enviadas, ${r.failureCount} fallidas`);
  await Promise.all(r.responses.map((x, i) => !x.success && /registration-token-not-registered|invalid-argument/.test(x.error?.code || "") ? db.collection("push").doc(tokens[i]).delete() : null));
} else console.log("Push: ningún móvil activado todavía.");
