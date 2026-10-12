// Parsers for Google Maps Timeline exports (on-device Android/iOS formats and
// legacy Takeout Records.json) and GPX files. Each returns
// { track: [{lat,lng,t}], visits: [{lat,lng,t,end,name}] } with t in epoch ms.
(function (root) {
  function parseLatLng(v) {
    if (!v) return null;
    if (typeof v === 'object') {
      if (v.latLng) return parseLatLng(v.latLng);
      if (v.LatLng) return parseLatLng(v.LatLng);
      if ('latitudeE7' in v) return [v.latitudeE7 / 1e7, v.longitudeE7 / 1e7];
      return null;
    }
    const m = String(v).replace(/^geo:/, '').match(/(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return [lat, lng];
  }

  function ms(t) { const n = Date.parse(t); return isNaN(n) ? null : n; }

  function parseTimeline(json) {
    const track = [], visits = [];
    const push = (ll, t) => { if (ll && t != null) track.push({ lat: ll[0], lng: ll[1], t }); };
    const segs = Array.isArray(json) ? json : (json.semanticSegments || []);

    for (const s of segs) {
      const start = ms(s.startTime), end = ms(s.endTime);
      if (Array.isArray(s.timelinePath)) {
        for (const p of s.timelinePath) {
          let t = p.time ? ms(p.time) : null;
          if (t == null && p.durationMinutesOffsetFromStartTime != null && start != null)
            t = start + (+p.durationMinutesOffsetFromStartTime) * 60000;
          push(parseLatLng(p.point), t ?? start);
        }
      }
      if (s.visit) {
        const tc = s.visit.topCandidate || {};
        const ll = parseLatLng(tc.placeLocation);
        if (ll && start != null) {
          visits.push({ lat: ll[0], lng: ll[1], t: start, end: end ?? start, name: tc.semanticType && tc.semanticType !== 'UNKNOWN' ? tc.semanticType : '' });
          push(ll, start); push(ll, end ?? start);
        }
      }
      if (s.activity) {
        push(parseLatLng(s.activity.start), start);
        push(parseLatLng(s.activity.end), end);
      }
    }

    for (const r of json.rawSignals || []) {
      const p = r.position;
      if (p) push(parseLatLng(p.LatLng || p.latLng), ms(p.timestamp));
    }

    for (const l of json.locations || []) {
      const t = l.timestamp ? ms(l.timestamp) : (l.timestampMs ? +l.timestampMs : null);
      push(parseLatLng(l), t);
    }
    return { track, visits };
  }

  function parseGPX(text) {
    const track = [], visits = [];
    const re = /<(trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/\1>|<(trkpt|rtept|wpt)\b([^>]*)\/>/g;
    let m;
    while ((m = re.exec(text))) {
      const tag = m[1] || m[4], attrs = m[2] || m[5] || '', body = m[3] || '';
      const lat = attrs.match(/lat\s*=\s*["']([^"']+)/), lon = attrs.match(/lon\s*=\s*["']([^"']+)/);
      if (!lat || !lon) continue;
      const tm = body.match(/<time>([^<]+)<\/time>/);
      const t = tm ? ms(tm[1]) : null;
      if (t == null) continue;
      const pt = { lat: +lat[1], lng: +lon[1], t };
      if (tag === 'wpt') {
        const nm = body.match(/<name>([^<]*)<\/name>/);
        visits.push({ ...pt, end: t, name: nm ? nm[1] : '' });
      } else track.push(pt);
    }
    return { track, visits };
  }

  function parseFile(name, text) {
    const trimmed = text.trimStart();
    if (/\.gpx$/i.test(name) || trimmed.startsWith('<')) return parseGPX(text);
    return parseTimeline(JSON.parse(text));
  }

  function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Split a time-sorted track into drawable segments. Breaks on long silent
  // gaps that also jump far (avoids straight lines across missing data) and
  // on implausible speeds (flights, GPS spikes).
  function segment(points) {
    const segs = [];
    let cur = [];
    for (const p of points) {
      const prev = cur[cur.length - 1];
      if (prev) {
        const d = haversine(prev, p), dt = Math.max(1, p.t - prev.t) / 1000;
        const gap = dt > 20 * 60 && d > 400;
        const tooFast = d > 3000 && d / dt > 70; // >250 km/h
        if (gap || tooFast) { if (cur.length > 1) segs.push(cur); cur = []; }
      }
      cur.push(p);
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  function segLength(seg) {
    let d = 0;
    for (let i = 1; i < seg.length; i++) d += haversine(seg[i - 1], seg[i]);
    return d;
  }

  function toGPX(name, track, visits) {
    const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const iso = t => new Date(t).toISOString();
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trailbook" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    for (const v of visits) out += `<wpt lat="${v.lat}" lon="${v.lng}"><time>${iso(v.t)}</time><name>${esc(v.name || 'Stop')}</name></wpt>\n`;
    out += `<trk><name>${esc(name)}</name>\n`;
    for (const seg of segment(track)) {
      out += '<trkseg>\n';
      for (const p of seg) out += `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${iso(p.t)}</time></trkpt>\n`;
      out += '</trkseg>\n';
    }
    return out + '</trk>\n</gpx>\n';
  }

  root.TB = { parseLatLng, parseTimeline, parseGPX, parseFile, haversine, segment, segLength, toGPX };
})(typeof window !== 'undefined' ? window : globalThis);
