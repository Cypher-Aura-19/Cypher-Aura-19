#!/usr/bin/env node
/**
 * Generates self-hosted "case file" SVG stat cards from live GitHub data.
 *
 * Everything is rendered locally into assets/cards/*.svg — no third-party
 * card hosts, so nothing can rate-limit or 402 the README.
 *
 * Usage:  GITHUB_TOKEN=xxx GH_USER=Cypher-Aura-19 node .github/scripts/generate-cards.mjs
 *
 * Without a token it still runs, using only unauthenticated REST data, and
 * marks contribution-derived cards as awaiting data rather than inventing it.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const USER = process.env.GH_USER || 'Cypher-Aura-19';
const TOKEN = process.env.GITHUB_TOKEN || '';
const OUT_DIR = 'assets/cards';
const LOCAL_REPOS = process.env.LOCAL_REPOS || '';

/* ─────────────────────────── theme ─────────────────────────── */

const T = {
  bg: '#0A0A0B',
  panel: '#101014',
  panelAlt: '#15151A',
  red: '#E01B24',
  redDim: '#8E1219',
  redDeep: '#5C0A0F',
  redBright: '#FF4C4C',
  text: '#E6EDF3',
  muted: '#7D8590',
  line: '#212429',
  grid: '#161619',
};

// Red-monochrome ramp used for languages and heat levels, so the whole
// profile reads as one palette instead of rainbow language colors.
const RAMP = ['#FF6B6B', '#FF4C4C', '#E01B24', '#B5121B', '#8E1219', '#5C0A0F', '#3A0509'];
const HEAT = ['#141417', '#4A0A0E', '#8E1219', '#D01822', '#FF5A5A'];

const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace";

/* ─────────────────────────── helpers ─────────────────────────── */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const nf = (n) => Number(n).toLocaleString('en-US');

function short(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

async function api(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'card-generator' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status}`);
  return res.json();
}

async function graphql(query, variables) {
  if (!TOKEN) return null;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'card-generator',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    console.warn(`WARN: GraphQL → ${res.status}`);
    return null;
  }
  const json = await res.json();
  if (json.errors) {
    console.warn('WARN: GraphQL errors:', JSON.stringify(json.errors).slice(0, 300));
    return null;
  }
  return json.data;
}

/* ─────────────────────────── shared chrome ─────────────────────────── */

/** Corner registration brackets, like the corners of an evidence photo. */
function brackets(w, h, len = 13, inset = 6, color = T.red, sw = 1.6) {
  const c = [
    [inset, inset, 1, 1],
    [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1],
    [w - inset, h - inset, -1, -1],
  ];
  return c
    .map(
      ([x, y, dx, dy]) =>
        `<path d="M${x} ${y + dy * len}L${x} ${y}L${x + dx * len} ${y}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="square"/>`
    )
    .join('');
}

/** Card shell: background, hairline border, corner brackets, header strip. */
function shell(w, h, label, tag) {
  return `
  <rect width="${w}" height="${h}" rx="10" fill="${T.bg}"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="9.5" fill="none" stroke="${T.line}"/>
  <rect x="0" y="0" width="${w}" height="34" rx="10" fill="${T.panel}"/>
  <rect x="0" y="33" width="${w}" height="1" fill="${T.line}"/>
  <rect x="14" y="13" width="8" height="8" fill="${T.red}"/>
  <text x="30" y="21.5" font-family="${MONO}" font-size="11" font-weight="700"
        letter-spacing="1.7" fill="${T.text}">${esc(label)}</text>
  ${
    tag
      ? `<text x="${w - 14}" y="21.5" text-anchor="end" font-family="${MONO}" font-size="9.5"
              letter-spacing="1.2" fill="${T.muted}">${esc(tag)}</text>`
      : ''
  }
  ${brackets(w, h)}`;
}

/** Fade-in keyframes; CSS animation inside SVG works when loaded via <img>. */
/**
 * Base state is opacity:1 and the keyframe fades *from* 0. If a renderer
 * ignores CSS animation (or is mid-delay), content stays visible instead of
 * disappearing — an opacity:0 base would render blank cards.
 */
function styleBlock(extra = '') {
  return `<style>
    .fi{opacity:1;animation:fi .55s ease-out forwards}
    @keyframes fi{from{opacity:0}to{opacity:1}}
    @media (prefers-reduced-motion:reduce){
      .fi{animation:none}
    }
    ${extra}
  </style>`;
}

const svgOpen = (w, h, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>`;

function save(name, body) {
  const path = `${OUT_DIR}/${name}`;
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.replace(/\n\s*\n/g, '\n'), 'utf8');
  console.log(`wrote ${path} (${body.length} bytes)`);
}

/* ─────────────────────────── card: dossier ─────────────────────────── */

function cardDossier(d) {
  const W = 440,
    H = 210;
  // Contribution-derived counts need GraphQL; show "—" rather than a false 0.
  const g = (n) => (d.gqKnown ? short(n) : '—');
  const c = d.counts || { source: d.repos, forked: 0, public: d.repos };
  const stats = [
    ['COMMITS', g(d.commits)],
    ['PULL REQUESTS', g(d.prs)],
    // Source + forked, so the total matches the profile's own repo tab.
    ['REPOSITORIES', `${short(c.public)}`],
    ['STARS EARNED', short(d.stars)],
    ['FORKED / SOURCE', `${short(c.forked)} / ${short(c.source)}`],
    ['FOLLOWERS', short(d.followers)],
  ];

  // Two columns of three rows.
  const rows = stats
    .map((s, i) => {
      const col = i % 2;
      const row = (i - col) / 2;
      const x = 20 + col * 208;
      const y = 66 + row * 40;
      return `
    <g class="fi" style="animation-delay:${90 + i * 55}ms">
      <rect x="${x}" y="${y - 13}" width="3" height="26" fill="${col ? T.redDim : T.red}"/>
      <text x="${x + 12}" y="${y - 2}" font-family="${MONO}" font-size="8.5" letter-spacing="1.3"
            fill="${T.muted}">${esc(s[0])}</text>
      <text x="${x + 12}" y="${y + 12}" font-family="${MONO}" font-size="16" font-weight="700"
            fill="${T.text}">${esc(s[1])}</text>
    </g>`;
    })
    .join('');

  return `${svgOpen(W, H, `${USER} — subject stats`)}
  ${styleBlock()}
  ${shell(W, H, 'CASE FILE · SUBJECT STATS', `#${d.caseNo}`)}
  <text x="20" y="52" font-family="${MONO}" font-size="9" letter-spacing="1.1" fill="${T.muted}">
    SUBJECT: <tspan fill="${T.text}" font-weight="700">${esc(d.name.toUpperCase())}</tspan>
    <tspan fill="${T.line}"> │ </tspan>ACTIVE SINCE <tspan fill="${T.text}">${esc(d.since)}</tspan>
  </text>
  ${rows}
  <rect x="20" y="${H - 26}" width="${W - 40}" height="1" fill="${T.line}"/>
  <text x="20" y="${H - 12}" font-family="${MONO}" font-size="8" letter-spacing="1.1" fill="${T.muted}">
    STATUS <tspan fill="${T.red}" font-weight="700">● SHIPPING</tspan>
  </text>
  <text x="${W - 20}" y="${H - 12}" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">SYNCED ${esc(d.syncedAt || d.stamp)}</text>
</svg>`;
}

/* ─────────────────────────── card: languages ─────────────────────────── */

function cardLanguages(langs, unit) {
  const W = 440,
    H = 210;
  const top = langs.slice(0, 6);
  const total = top.reduce((a, l) => a + l.value, 0) || 1;
  const byBytes = unit === 'bytes';

  const barX = 20,
    barY = 56,
    barW = W - 40,
    barH = 16;

  let acc = 0;
  const segs = top
    .map((l, i) => {
      const frac = l.value / total;
      const w = Math.max(frac * barW, 2);
      const x = barX + acc;
      acc += w;
      return `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barH}"
        fill="${RAMP[i]}" class="fi" style="animation-delay:${120 + i * 70}ms"/>`;
    })
    .join('');

  const legend = top
    .map((l, i) => {
      const col = i % 2;
      const row = (i - col) / 2;
      const x = 20 + col * 210;
      const y = 106 + row * 30;
      const pct = ((l.value / total) * 100).toFixed(1);
      return `
    <g class="fi" style="animation-delay:${220 + i * 55}ms">
      <rect x="${x}" y="${y - 8}" width="9" height="9" rx="1.5" fill="${RAMP[i]}"/>
      <text x="${x + 16}" y="${y}" font-family="${MONO}" font-size="10.5" fill="${T.text}">${esc(l.name)}</text>
      <text x="${x + 190}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="10.5"
            font-weight="700" fill="${T.muted}">${pct}%</text>
    </g>`;
    })
    .join('');

  return `${svgOpen(W, H, `${USER} — language composition`)}
  ${styleBlock()}
  ${shell(W, H, 'TRACE ANALYSIS · LANGUAGES', `${top.length} SAMPLES`)}
  <text x="20" y="49" font-family="${MONO}" font-size="8.5" letter-spacing="1.2" fill="${T.muted}">
    ${byBytes ? 'COMPOSITION BY BYTES WRITTEN' : 'COMPOSITION BY REPOSITORY COUNT'}
  </text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="3" fill="${T.panelAlt}"/>
  <g clip-path="url(#slide)">${segs}</g>
  <clipPath id="slide"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="3"/></clipPath>
  <rect x="${barX}" y="${barY}" width="${barW}" height="5" rx="2.5" fill="#FFFFFF" opacity="0.07"/>
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="3" fill="none" stroke="${T.line}"/>
  ${legend}
  <rect x="20" y="${H - 26}" width="${W - 40}" height="1" fill="${T.line}"/>
  <text x="20" y="${H - 12}" font-family="${MONO}" font-size="8" letter-spacing="1.1" fill="${T.muted}">
    PRIMARY <tspan fill="${T.red}" font-weight="700">${esc((top[0]?.name || 'N/A').toUpperCase())}</tspan>
  </text>
  <text x="${W - 20}" y="${H - 12}" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">${byBytes ? esc(short(total)) + ' BYTES' : esc(nf(total)) + ' REPOS'}</text>
</svg>`;
}

/* ─────────────────────────── card: streak ─────────────────────────── */

function cardStreak(s) {
  const W = 440,
    H = 210;
  const cx = 96,
    cy = 118,
    r = 42;
  const circ = 2 * Math.PI * r;
  const pct = s.longest > 0 ? Math.min(s.current / s.longest, 1) : 0;
  const dash = (circ * pct).toFixed(1);

  return `${svgOpen(W, H, `${USER} — commit streak`)}
  ${styleBlock(`.ring{animation:ring 1.1s ease-out forwards}
    @keyframes ring{from{stroke-dasharray:0 ${circ.toFixed(1)}}}`)}
  ${shell(W, H, 'PATTERN · COMMIT STREAK', s.known ? 'VERIFIED' : 'PENDING')}

  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${T.panelAlt}" stroke-width="9"/>
  <circle class="ring" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${T.red}" stroke-width="9"
          stroke-linecap="round" stroke-dasharray="${dash} ${circ.toFixed(1)}"
          transform="rotate(-90 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy + 3}" text-anchor="middle" font-family="${MONO}" font-size="26"
        font-weight="700" fill="${T.text}">${s.known ? s.current : '—'}</text>
  <text x="${cx}" y="${cy + 19}" text-anchor="middle" font-family="${MONO}" font-size="8"
        letter-spacing="1.3" fill="${T.muted}">DAY STREAK</text>

  ${[
    ['LONGEST STREAK', s.known ? `${s.longest} DAYS` : 'AWAITING DATA'],
    ['TOTAL CONTRIBUTIONS', s.known ? nf(s.total) : 'AWAITING DATA'],
    ['ACTIVE THIS YEAR', s.known ? `${s.activeDays} DAYS` : 'AWAITING DATA'],
  ]
    .map(
      ([k, v], i) => `
  <g class="fi" style="animation-delay:${180 + i * 80}ms">
    <rect x="176" y="${73 + i * 42}" width="3" height="26" fill="${i === 0 ? T.red : T.redDim}"/>
    <text x="188" y="${85 + i * 42}" font-family="${MONO}" font-size="8.5" letter-spacing="1.3"
          fill="${T.muted}">${esc(k)}</text>
    <text x="188" y="${99 + i * 42}" font-family="${MONO}" font-size="14" font-weight="700"
          fill="${T.text}">${esc(v)}</text>
  </g>`
    )
    .join('')}
</svg>`;
}

/* ─────────────────────────── card: heatmap ─────────────────────────── */

function cardHeatmap(cal) {
  const W = 880,
    H = 252;
  const cell = 11,
    gap = 3,
    step = cell + gap;
  const gx = 46,
    gy = 80;

  let grid = '';
  let monthLabels = '';
  let tips = '';

  if (cal.known) {
    const weeks = cal.weeks;
    const max = Math.max(1, ...weeks.flatMap((w) => w.days.map((d) => d.count)));

    // Busiest day per month becomes a tooltip stop, so the roving readout
    // tours the year's highlights instead of 365 near-empty squares.
    const monthPeaks = new Map();

    weeks.forEach((wk, wi) => {
      wk.days.forEach((day) => {
        let lvl = 0;
        if (day.count > 0) {
          const q = day.count / max;
          lvl = q > 0.66 ? 4 : q > 0.4 ? 3 : q > 0.15 ? 2 : 1;
        }
        const cxp = gx + wi * step;
        const cyp = gy + day.weekday * step;
        grid += `<rect x="${cxp}" y="${cyp}" width="${cell}" height="${cell}" rx="2.5" fill="${HEAT[lvl]}"/>`;

        if (day.count > 0 && day.date) {
          const mk = day.date.slice(0, 7);
          const prev = monthPeaks.get(mk);
          if (!prev || day.count > prev.count) {
            monthPeaks.set(mk, { ...day, x: cxp, y: cyp });
          }
        }
      });
      if (wk.firstOfMonth) {
        monthLabels += `<text x="${gx + wi * step}" y="${gy - 9}" font-family="${MONO}" font-size="8.5"
          letter-spacing="1" fill="${T.muted}">${esc(wk.firstOfMonth)}</text>`;
      }
    });

    /* Roving tooltip over each month's busiest day. camo strips :hover, so the
       readout advances on a timer — the same detail GitHub shows on hover. */
    const stops = [...monthPeaks.values()].sort((a, b) => a.date.localeCompare(b.date));
    const dwell = 1.5;
    const cycle = (stops.length * dwell).toFixed(2);
    const tipW = 132,
      tipH = 36;

    tips = stops
      .map((s, i) => {
        const tx = Math.min(Math.max(s.x + cell / 2 - tipW / 2, 16), W - tipW - 16);
        const ty = gy + 7 * step + 6;
        const pct = ((i / stops.length) * 100).toFixed(3);
        const pctEnd = (((i + 1) / stops.length) * 100).toFixed(3);
        // Hold each stop for its whole slice and cross-fade at the boundary,
        // so the readout band is never caught empty mid-cycle.
        const fade = 0.25;
        const nice = new Date(`${s.date}T00:00:00Z`).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
        return `
  <g class="tip" style="animation-name:h${i}">
    <rect x="${s.x - 2}" y="${s.y - 2}" width="${cell + 4}" height="${cell + 4}" rx="3.5"
          fill="none" stroke="${T.redBright}" stroke-width="1.6"/>
    <rect x="${tx.toFixed(1)}" y="${ty}" width="${tipW}" height="${tipH}" rx="6"
          fill="${T.panel}" stroke="${T.redDim}"/>
    <text x="${(tx + 11).toFixed(1)}" y="${ty + 15}" font-family="${MONO}" font-size="8"
          letter-spacing="1" fill="${T.muted}">${esc(nice.toUpperCase())}</text>
    <text x="${(tx + 11).toFixed(1)}" y="${ty + 28}" font-family="${MONO}" font-size="11"
          font-weight="700" fill="${T.text}">${s.count} <tspan font-size="7.5" font-weight="400"
          fill="${T.muted}">CONTRIBUTION${s.count === 1 ? '' : 'S'}</tspan></text>
  </g>
  <style>@keyframes h${i}{
    0%,${Math.max(0, Number(pct) - fade).toFixed(3)}%{opacity:0}
    ${pct}%,${pctEnd}%{opacity:1}
    ${Math.min(100, Number(pctEnd) + fade).toFixed(3)}%,100%{opacity:0}
  }</style>`;
      })
      .join('');

    // First stop appears immediately: an empty readout on load looks broken.
    tips = `<style>.tip{opacity:0;animation-duration:${cycle}s;
      animation-iteration-count:infinite;animation-timing-function:linear}
      @media (prefers-reduced-motion:reduce){.tip{animation:none;opacity:0}}</style>${tips}`;
  } else {
    // No token: draw the empty grid so layout is visible, but do not fake counts.
    for (let w = 0; w < 53; w++)
      for (let d = 0; d < 7; d++)
        grid += `<rect x="${gx + w * step}" y="${gy + d * step}" width="${cell}" height="${cell}" rx="2.5" fill="${HEAT[0]}"/>`;
  }

  const dayLabels = ['MON', 'WED', 'FRI']
    .map(
      (l, i) =>
        `<text x="${gx - 10}" y="${gy + (i * 2 + 1) * step + 8}" text-anchor="end"
          font-family="${MONO}" font-size="8" letter-spacing="0.8" fill="${T.muted}">${l}</text>`
    )
    .join('');

  const legend = HEAT.map(
    (c, i) =>
      `<rect x="${W - 128 + i * 15}" y="42" width="11" height="11" rx="2.5" fill="${c}"/>`
  ).join('');

  return `${svgOpen(W, H, `${USER} — contribution spatter pattern`)}
  ${styleBlock()}
  ${shell(W, H, 'SPATTER PATTERN · 52 WEEKS', cal.known ? `${nf(cal.total)} CONTRIBUTIONS` : 'AWAITING DATA')}
  <text x="20" y="50" font-family="${MONO}" font-size="8.5" letter-spacing="1.2" fill="${T.muted}">
    READOUT TOURS EACH MONTH'S BUSIEST DAY
  </text>
  ${monthLabels}
  ${dayLabels}
  <g class="fi" style="animation-delay:120ms">${grid}</g>
  ${tips}
  <text x="${W - 146}" y="51" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">LESS</text>
  ${legend}
  <text x="${W - 20}" y="51" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">MORE</text>
</svg>`;
}

/* ─────────────────────────── card: top repos ─────────────────────────── */

function cardRepos(repos) {
  const W = 880,
    H = 190;
  const top = repos.slice(0, 4);
  const maxStars = Math.max(1, ...top.map((r) => r.stars));
  const colW = 208;

  const cards = top
    .map((r, i) => {
      const x = 20 + i * (colW + 8);
      const barW = Math.max(4, (r.stars / maxStars) * (colW - 24));
      return `
    <g class="fi" style="animation-delay:${120 + i * 70}ms">
      <rect x="${x}" y="52" width="${colW}" height="118" rx="7" fill="${T.panel}" stroke="${T.line}"/>
      <rect x="${x}" y="52" width="3" height="118" rx="1.5" fill="${RAMP[i + 1]}"/>
      <text x="${x + 14}" y="74" font-family="${MONO}" font-size="8" letter-spacing="1.2"
            fill="${T.muted}">EXHIBIT ${String.fromCharCode(65 + i)}</text>
      <text x="${x + 14}" y="92" font-family="${MONO}" font-size="11.5" font-weight="700"
            fill="${T.text}">${esc(r.name.slice(0, 20))}</text>
      <text x="${x + 14}" y="110" font-family="${MONO}" font-size="8.5" fill="${T.muted}">
        ${esc((r.desc || 'no description').slice(0, 26))}
      </text>
      <rect x="${x + 14}" y="122" width="${barW.toFixed(1)}" height="4" rx="2" fill="${RAMP[i + 1]}"/>
      <text x="${x + 14}" y="146" font-family="${MONO}" font-size="9" fill="${T.text}">
        ★ ${r.stars} <tspan fill="${T.muted}">· ⑂ ${r.forks}</tspan>
      </text>
      <text x="${x + 14}" y="161" font-family="${MONO}" font-size="8" letter-spacing="1"
            fill="${RAMP[i + 1]}">${esc((r.lang || 'MIXED').toUpperCase())}</text>
    </g>`;
    })
    .join('');

  return `${svgOpen(W, H, `${USER} — top repositories`)}
  ${styleBlock()}
  ${shell(W, H, 'EVIDENCE LOCKER · TOP REPOSITORIES', `${nf(repos.length)} FILED`)}
  ${cards}
</svg>`;
}

/* ─────────────────── card: upstream open-source work ─────────────────── */

/**
 * External projects this user has landed work in, ranked by upstream stars.
 *
 * PR state is shown per project (merged / open / closed) so a drive-by patch
 * never reads as an accepted contribution.
 */
function cardUpstream(up) {
  const W = 880,
    H = 250;

  if (!up.known || !up.projects.length) {
    return `${svgOpen(W, H, 'upstream contributions')}
  ${styleBlock()}
  ${shell(W, H, 'FIELD WORK · UPSTREAM CONTRIBUTIONS', 'AWAITING DATA')}
  <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${MONO}" font-size="11"
        letter-spacing="1.4" fill="${T.muted}">AWAITING CONTRIBUTION DATA</text>
</svg>`;
  }

  const top = up.projects.slice(0, 8);
  const maxStars = Math.max(1, ...top.map((p) => p.stars));

  const rowH = 21;
  const y0 = 74;
  const barX = 470;
  const barMax = W - barX - 96;

  const rows = top
    .map((p, i) => {
      const y = y0 + i * rowH;
      const bw = Math.max(3, (p.stars / maxStars) * barMax);
      // Merged work earns the bright red; unmerged stays dim and honest.
      const col = p.merged > 0 ? T.redBright : RAMP[2];
      const state =
        p.merged > 0
          ? `${p.merged} MERGED`
          : p.open > 0
            ? `${p.open} OPEN`
            : p.closed > 0
              ? 'CLOSED'
              : 'COMMITS';
      return `
    <g class="fi" style="animation-delay:${110 + i * 60}ms">
      <rect x="20" y="${y - 12}" width="3" height="15" fill="${col}"/>
      <text x="31" y="${y}" font-family="${MONO}" font-size="10.5" fill="${T.text}">${esc(p.name.slice(0, 34))}</text>
      <text x="330" y="${y}" font-family="${MONO}" font-size="8.5" letter-spacing="0.9"
            fill="${p.merged > 0 ? T.redBright : T.muted}">${esc(state)}</text>
      <rect x="${barX}" y="${y - 8}" width="${barMax}" height="9" rx="4.5" fill="${T.grid}"/>
      <rect x="${barX}" y="${y - 8}" width="${bw.toFixed(1)}" height="9" rx="4.5" fill="${col}"/>
      <text x="${W - 20}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="9.5"
            font-weight="700" fill="${T.muted}">${esc(short(p.stars))} ★</text>
    </g>`;
    })
    .join('');

  const reach = up.projects.reduce((a, p) => a + p.stars, 0);

  return `${svgOpen(W, H, 'upstream open-source contributions')}
  ${styleBlock()}
  ${shell(W, H, 'FIELD WORK · UPSTREAM CONTRIBUTIONS', `${up.totalCount} PROJECTS`)}
  <text x="20" y="50" font-family="${MONO}" font-size="8.5" letter-spacing="1.2" fill="${T.muted}">
    OTHER PEOPLE'S CODEBASES I LEFT EVIDENCE IN · RANKED BY REACH
  </text>
  ${rows}
  <rect x="20" y="${H - 27}" width="${W - 40}" height="1" fill="${T.line}"/>
  <text x="20" y="${H - 12}" font-family="${MONO}" font-size="8" letter-spacing="1.1" fill="${T.muted}">
    COMBINED REACH <tspan fill="${T.red}" font-weight="700">${esc(short(reach))} STARS</tspan>
    <tspan fill="${T.line}"> │ </tspan>MERGED <tspan fill="${T.redBright}" font-weight="700">${up.merged}</tspan>
  </text>
  <text x="${W - 20}" y="${H - 12}" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">BRIGHT = MERGED UPSTREAM</text>
</svg>`;
}

/* ─────────────────────────── card: quote ─────────────────────────── */

/**
 * Self-hosted replacement for quotes-github-readme.vercel.app, themed to the
 * case-file aesthetic. The line is picked from the data stamp rather than
 * Math.random() so a regenerated card is reproducible for a given day.
 */
function cardQuote(seed) {
  const W = 880,
    H = 132;

  const lines = [
    ['Tonight is the night. And it is going to happen', 'again and again.'],
    ['I am not the monster he wants me to be,', 'so I am neither man nor beast.'],
    ['There are no secrets in life,', 'just hidden truths that lie beneath the surface.'],
    ['Blood. Sometimes it sets my teeth on edge,', 'other times it helps me control the chaos.'],
    ['People fake a lot of human interactions,', 'but I feel like I fake them all.'],
    ['I have a code. It keeps me in line.', 'Ship clean, leave no trace.'],
  ];

  const idx =
    [...String(seed)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % lines.length;
  const [l1, l2] = lines[idx];

  return `${svgOpen(W, H, 'quote of the day')}
  ${styleBlock(`.cur{animation:blink 1.05s steps(1,end) infinite}
    @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}`)}
  ${shell(W, H, 'INTERROGATION LOG · ON THE RECORD', 'DEXTER MORGAN')}
  <text x="30" y="50" font-family="${MONO}" font-size="30" font-weight="700"
        fill="${T.redDeep}" opacity="0.9">&#8220;</text>
  <g class="fi" style="animation-delay:120ms">
    <text x="56" y="72" font-family="${MONO}" font-size="13" fill="${T.text}">${esc(l1)}</text>
    <text x="56" y="93" font-family="${MONO}" font-size="13" fill="${T.text}">${esc(l2)}<tspan
      class="cur" fill="${T.red}" font-weight="700">_</tspan></text>
  </g>
  <rect x="30" y="56" width="2" height="44" fill="${T.red}"/>
  <text x="${W - 20}" y="${H - 14}" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">ROTATES DAILY</text>
</svg>`;
}

/* ─────────────────────────── data gathering ─────────────────────────── */

/**
 * Repos + per-repo language bytes in one paginated GraphQL call.
 *
 * The REST `/users/:u/repos` route this used to call silently under-reports:
 * it omits repos the token can see but the public listing hides, so the count
 * came out at 47 against a real 86. GraphQL's `totalCount` is authoritative,
 * and `languages` arrives inline instead of costing one REST call per repo.
 */
const REPOS_Q = `
query($login:String!, $cursor:String){
  user(login:$login){
    name login createdAt
    followers{ totalCount }
    allRepos:    repositories(ownerAffiliations:OWNER){ totalCount }
    publicRepos: repositories(ownerAffiliations:OWNER, privacy:PUBLIC){ totalCount }
    forkedRepos: repositories(ownerAffiliations:OWNER, isFork:true){ totalCount }
    repositories(ownerAffiliations:OWNER, isFork:false, first:100, after:$cursor,
                 orderBy:{field:STARGAZERS, direction:DESC}){
      totalCount
      pageInfo{ hasNextPage endCursor }
      nodes{
        name description stargazerCount forkCount
        primaryLanguage{ name }
        languages(first:12, orderBy:{field:SIZE, direction:DESC}){
          edges{ size node{ name } }
        }
      }
    }
  }
}`;

/** Upstream projects this user has landed work in, with per-repo PR state. */
const UPSTREAM_Q = `
query($login:String!){
  user(login:$login){
    repositoriesContributedTo(first:100, includeUserRepositories:false,
        contributionTypes:[COMMIT, PULL_REQUEST, ISSUE, PULL_REQUEST_REVIEW],
        orderBy:{field:STARGAZERS, direction:DESC}){
      totalCount
      nodes{ nameWithOwner stargazerCount primaryLanguage{ name } }
    }
    pullRequests(first:100, states:[OPEN,CLOSED,MERGED],
        orderBy:{field:CREATED_AT, direction:DESC}){
      totalCount
      nodes{ state merged repository{ nameWithOwner stargazerCount primaryLanguage{ name } } }
    }
  }
}`;

async function gather() {
  const user = await api(`/users/${USER}`);

  /* ── repos + languages, straight from GraphQL ── */
  let owned = [];
  let counts = { all: 0, public: 0, forked: 0, source: 0 };
  let gqUser = null;

  if (TOKEN) {
    let cursor = null;
    for (let page = 0; page < 6; page++) {
      const data = await graphql(REPOS_Q, { login: USER, cursor });
      if (!data?.user) break;
      gqUser = data.user;
      const r = data.user.repositories;
      owned.push(...r.nodes);
      counts = {
        all: data.user.allRepos.totalCount,
        public: data.user.publicRepos.totalCount,
        forked: data.user.forkedRepos.totalCount,
        source: r.totalCount,
      };
      if (!r.pageInfo.hasNextPage) break;
      cursor = r.pageInfo.endCursor;
    }
    console.log(
      `repos → ${counts.source} source · ${counts.forked} forked · ${counts.public} public · ${counts.all} total`
    );
  }

  /* REST fallback keeps the script usable with no token, at lower fidelity. */
  if (!owned.length) {
    let rest = [];
    if (LOCAL_REPOS && existsSync(LOCAL_REPOS)) {
      rest = JSON.parse(readFileSync(LOCAL_REPOS, 'utf8'));
      console.log(`using cached repo list (${rest.length})`);
    } else {
      for (let page = 1; page <= 5; page++) {
        const batch = await api(`/users/${USER}/repos?per_page=100&page=${page}&sort=pushed`);
        rest.push(...batch);
        if (batch.length < 100) break;
      }
    }
    owned = rest
      .filter((r) => !r.fork)
      .map((r) => ({
        name: r.name,
        description: r.description,
        stargazerCount: r.stargazers_count,
        forkCount: r.forks_count,
        primaryLanguage: r.language ? { name: r.language } : null,
        languages: { edges: [] },
      }));
    counts = {
      all: user.public_repos,
      public: user.public_repos,
      forked: rest.length - owned.length,
      source: owned.length,
    };
  }

  const stars = owned.reduce((a, r) => a + r.stargazerCount, 0);
  const forks = owned.reduce((a, r) => a + r.forkCount, 0);

  /* languages: real byte totals when GraphQL answered, repo counts otherwise */
  let langs = [];
  let langUnit = 'bytes';
  const totals = new Map();
  for (const r of owned) {
    for (const e of r.languages?.edges || []) {
      totals.set(e.node.name, (totals.get(e.node.name) || 0) + e.size);
    }
  }
  langs = [...totals].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  if (!langs.length) {
    const c = new Map();
    for (const r of owned) {
      const n = r.primaryLanguage?.name;
      if (n) c.set(n, (c.get(n) || 0) + 1);
    }
    langs = [...c].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    langUnit = 'repos';
    console.log('note: language card using repository counts (no token)');
  }

  /* ── upstream open-source work ── */
  const up = await graphql(UPSTREAM_Q, { login: USER });
  let upstream = { known: false, projects: [], totalCount: 0, merged: 0 };

  if (up?.user) {
    // Fold PR state onto each project so the card can show merged vs open
    // honestly, rather than implying every touch was accepted.
    const byRepo = new Map();
    const note = (nameWithOwner, stars, lang) => {
      if (!byRepo.has(nameWithOwner)) {
        byRepo.set(nameWithOwner, { name: nameWithOwner, stars, lang, merged: 0, open: 0, closed: 0 });
      }
      return byRepo.get(nameWithOwner);
    };

    for (const n of up.user.repositoriesContributedTo.nodes) {
      note(n.nameWithOwner, n.stargazerCount, n.primaryLanguage?.name || null);
    }
    for (const pr of up.user.pullRequests.nodes) {
      const r = pr.repository;
      if (!r || r.nameWithOwner.split('/')[0].toLowerCase() === USER.toLowerCase()) continue;
      const e = note(r.nameWithOwner, r.stargazerCount, r.primaryLanguage?.name || null);
      if (pr.merged) e.merged++;
      else if (pr.state === 'OPEN') e.open++;
      else e.closed++;
    }

    const projects = [...byRepo.values()].sort((a, b) => b.stars - a.stars);
    upstream = {
      known: projects.length > 0,
      projects,
      totalCount: byRepo.size,
      merged: projects.reduce((a, p) => a + p.merged, 0),
    };
    console.log(`upstream → ${upstream.totalCount} projects · ${upstream.merged} merged PRs`);
  }

  /* contributions + counts via GraphQL */
  const gq = await graphql(
    `query($login:String!){
      user(login:$login){
        contributionsCollection{
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          totalRepositoryContributions
          restrictedContributionsCount
          contributionCalendar{
            totalContributions
            weeks{ contributionDays{ contributionCount date weekday } }
          }
        }
        pullRequests(states:[OPEN,CLOSED,MERGED]){ totalCount }
        issues{ totalCount }
        repositories(ownerAffiliations:OWNER){ totalCount }
      }
    }`,
    { login: USER }
  );

  let cal = { known: false, weeks: [], total: 0 };
  let streak = { known: false, current: 0, longest: 0, total: 0, activeDays: 0 };
  let monthly = { known: false, points: [] };
  let weekday = { known: false, values: [] };
  let mix = { known: false, parts: [] };
  let commits = 0,
    prs = 0,
    issues = 0;

  if (gq?.user) {
    const cc = gq.user.contributionsCollection;
    commits = cc.totalCommitContributions + (cc.restrictedContributionsCount || 0);
    prs = gq.user.pullRequests.totalCount;
    issues = gq.user.issues.totalCount;

    const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
    cal = {
      known: true,
      total: cc.contributionCalendar.totalContributions,
      weeks: cc.contributionCalendar.weeks.map((w, i) => {
        const first = w.contributionDays[0];
        const dt = new Date(first.date);
        const prev = cc.contributionCalendar.weeks[i - 1]?.contributionDays[0];
        const showMonth = !prev || new Date(prev.date).getMonth() !== dt.getMonth();
        return {
          days: w.contributionDays.map((d) => ({
            count: d.contributionCount,
            weekday: d.weekday,
            date: d.date,
          })),
          firstOfMonth: showMonth
            ? dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
            : null,
        };
      }),
    };

    // streaks, counted only up to today so an unfinished day never breaks it
    const today = new Date().toISOString().slice(0, 10);
    const past = days.filter((d) => d.date <= today);
    let cur = 0,
      best = 0,
      run = 0;
    for (const d of past) {
      if (d.contributionCount > 0) {
        run++;
        best = Math.max(best, run);
      } else run = 0;
    }
    for (let i = past.length - 1; i >= 0; i--) {
      if (past[i].contributionCount > 0) cur++;
      else if (i !== past.length - 1) break;
      else continue; // today still has time
    }
    streak = {
      known: true,
      current: cur,
      longest: best,
      total: cc.contributionCalendar.totalContributions,
      activeDays: past.filter((d) => d.contributionCount > 0).length,
    };

    /* monthly totals for the area chart */
    const byMonth = new Map();
    for (const d of days) {
      const key = d.date.slice(0, 7); // YYYY-MM
      byMonth.set(key, (byMonth.get(key) || 0) + d.contributionCount);
    }
    monthly = {
      known: true,
      points: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({
        label: new Date(`${k}-01T00:00:00Z`)
          .toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
          .toUpperCase(),
        value: v,
      })),
    };

    /* weekday distribution for the bar chart */
    const wd = new Array(7).fill(0);
    for (const d of days) wd[d.weekday] += d.contributionCount;
    weekday = { known: true, values: wd };

    /* contribution-type split for the donut.
       Commits include restricted (private) contributions so the donut total
       matches the calendar total exactly, instead of silently under-counting. */
    const parts = [
      { name: 'Commits', value: cc.totalCommitContributions + (cc.restrictedContributionsCount || 0) },
      { name: 'Pull Requests', value: cc.totalPullRequestContributions },
      { name: 'Code Reviews', value: cc.totalPullRequestReviewContributions },
      { name: 'Issues', value: cc.totalIssueContributions },
      { name: 'Repos Created', value: cc.totalRepositoryContributions },
    ].filter((p) => p.value > 0);
    mix = { known: parts.length > 0, parts };
  } else {
    console.log('note: no GraphQL data — streak/heatmap cards will render as AWAITING DATA');
  }

  const topRepos = owned
    .map((r) => ({
      name: r.name,
      desc: r.description,
      stars: r.stargazerCount,
      forks: r.forkCount,
      lang: r.primaryLanguage?.name || null,
    }))
    .sort((a, b) => b.stars - a.stars || b.forks - a.forks)
    .slice(0, 4);

  const created = new Date(user.created_at);
  const now = new Date();
  return {
    profile: {
      name: gqUser?.name || user.name || user.login,
      gqKnown: Boolean(gq?.user),
      commits,
      prs,
      issues,
      repos: counts.source,
      counts,
      stars,
      forks,
      followers: user.followers,
      since: created.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase(),
      caseNo: String(counts.public).padStart(3, '0'),
      stamp: now.toISOString().slice(0, 10),
      // Minute-precision stamp so the cards visibly prove how fresh the pull is.
      syncedAt: `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    },
    langs,
    langUnit,
    streak,
    cal,
    monthly,
    weekday,
    mix,
    topRepos,
    upstream,
  };
}

/* ─────────────────────────── card: area chart (shadcn style) ─────────────────────────── */

/**
 * Monthly contribution volume as a smooth gradient-filled area chart with
 * dotted gridlines and axis ticks — the shadcn/recharts look, hand-rolled.
 */
function cardAreaChart(series) {
  const W = 880,
    H = 260;
  const padL = 46,
    padR = 20,
    padT = 58,
    padB = 40;
  const cw = W - padL - padR;
  const ch = H - padT - padB;

  if (!series.known || series.points.length < 2) {
    return `${svgOpen(W, H, 'contribution volume')}
  ${styleBlock()}
  ${shell(W, H, 'VOLUME ANALYSIS · MONTHLY OUTPUT', 'AWAITING DATA')}
  <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${MONO}" font-size="11"
        letter-spacing="1.4" fill="${T.muted}">AWAITING CONTRIBUTION DATA</text>
</svg>`;
  }

  const pts = series.points;
  const maxV = Math.max(1, ...pts.map((p) => p.value));
  // Round the axis ceiling up to a clean step so ticks read nicely.
  const step = maxV <= 20 ? 5 : maxV <= 60 ? 20 : maxV <= 150 ? 50 : 100;
  const top = Math.ceil(maxV / step) * step;

  const X = (i) => padL + (i / (pts.length - 1)) * cw;
  const Y = (v) => padT + ch - (v / top) * ch;

  // Catmull-Rom → cubic Bézier for the smooth shadcn curve.
  let line = `M${X(0).toFixed(1)} ${Y(pts[0].value).toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = X(i) + (X(i + 1) - X(i - 1 < 0 ? 0 : i - 1)) / 6;
    const c1y = Y(p1.value) + (Y(p2.value) - Y(p0.value)) / 6;
    const c2x = X(i + 1) - (X(i + 2 > pts.length - 1 ? pts.length - 1 : i + 2) - X(i)) / 6;
    const c2y = Y(p2.value) - (Y(p3.value) - Y(p1.value)) / 6;
    line += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)},${c2x.toFixed(1)} ${c2y.toFixed(1)},${X(i + 1).toFixed(1)} ${Y(p2.value).toFixed(1)}`;
  }
  const area = `${line} L${X(pts.length - 1).toFixed(1)} ${(padT + ch).toFixed(1)} L${X(0).toFixed(1)} ${(padT + ch).toFixed(1)} Z`;

  const yTicks = Array.from({ length: top / step + 1 }, (_, i) => {
    const v = i * step;
    const y = Y(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"
      stroke="${T.line}" stroke-width="1" stroke-dasharray="3 4"/>
    <text x="${padL - 10}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-family="${MONO}"
      font-size="8.5" fill="${T.muted}">${v}</text>`;
  }).join('');

  const xTicks = pts
    .map((p, i) =>
      i % 2 === 0
        ? `<text x="${X(i).toFixed(1)}" y="${padT + ch + 20}" text-anchor="middle"
             font-family="${MONO}" font-size="8.5" letter-spacing="0.8" fill="${T.muted}">${esc(p.label)}</text>`
        : ''
    )
    .join('');

  const dots = pts
    .map(
      (p, i) =>
        `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="3" fill="${T.bg}"
          stroke="${T.red}" stroke-width="2"/>`
    )
    .join('');

  const peak = pts.reduce((a, b) => (b.value > a.value ? b : a), pts[0]);
  const peakI = pts.indexOf(peak);

  /* Roving tooltip.
     GitHub serves README images through camo as <img>, which blocks pointer
     events, so a real :hover tooltip can never fire. Instead the tooltip
     walks the series on a timer — same information a shadcn hover reveals,
     delivered without needing a cursor. */
  const dwell = 1.6; // seconds parked on each point
  const cycle = (pts.length * dwell).toFixed(2);
  const tipW = 96,
    tipH = 34;

  const tips = pts
    .map((p, i) => {
      const px = X(i);
      const py = Y(p.value);
      // Flip the tooltip inward at the edges so it never clips the frame.
      const tx = Math.min(Math.max(px - tipW / 2, padL), W - padR - tipW);
      const ty = Math.max(py - tipH - 12, padT + 2);
      const pct = ((i / pts.length) * 100).toFixed(3);
      const pctEnd = (((i + 1) / pts.length) * 100).toFixed(3);
      // Hold for the full slice, cross-fade at the edges — never caught empty.
      const fade = 0.25;
      return `
  <g class="tip" style="animation-name:t${i}">
    <line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${(padT + ch).toFixed(1)}"
          stroke="${T.redBright}" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>
    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="${T.redBright}"
            stroke="${T.bg}" stroke-width="2"/>
    <rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tipW}" height="${tipH}" rx="6"
          fill="${T.panel}" stroke="${T.redDim}"/>
    <text x="${(tx + 10).toFixed(1)}" y="${(ty + 14).toFixed(1)}" font-family="${MONO}"
          font-size="8" letter-spacing="1.1" fill="${T.muted}">${esc(p.label)}</text>
    <text x="${(tx + 10).toFixed(1)}" y="${(ty + 27).toFixed(1)}" font-family="${MONO}"
          font-size="11" font-weight="700" fill="${T.text}">${p.value} <tspan
          font-size="7.5" font-weight="400" fill="${T.muted}">CONTRIB</tspan></text>
  </g>
  <style>@keyframes t${i}{
    0%,${Math.max(0, Number(pct) - fade).toFixed(3)}%{opacity:0}
    ${pct}%,${pctEnd}%{opacity:1}
    ${Math.min(100, Number(pctEnd) + fade).toFixed(3)}%,100%{opacity:0}
  }</style>`;
    })
    .join('');

  return `${svgOpen(W, H, 'monthly contribution volume')}
  ${styleBlock(`.dr{stroke-dasharray:2600;stroke-dashoffset:0;animation:dr 1.5s ease-out forwards}
    @keyframes dr{from{stroke-dashoffset:2600}}
    .tip{opacity:0;animation-duration:${cycle}s;animation-iteration-count:infinite;
         animation-timing-function:linear}
    @media (prefers-reduced-motion:reduce){
      .dr{animation:none}
      .tip{animation:none;opacity:0}
    }`)}
  <defs>
    <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${T.red}" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="${T.red}" stop-opacity="0.13"/>
      <stop offset="100%" stop-color="${T.red}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${shell(W, H, 'VOLUME ANALYSIS · MONTHLY OUTPUT', `PEAK ${peak.value} · ${esc(peak.label)}`)}
  <text x="20" y="50" font-family="${MONO}" font-size="8.5" letter-spacing="1.2" fill="${T.muted}">
    CONTRIBUTIONS PER MONTH · TRAILING 12 MONTHS
  </text>
  ${yTicks}
  <path d="${area}" fill="url(#ag)" class="fi" style="animation-delay:200ms"/>
  <path d="${line}" fill="none" stroke="${T.red}" stroke-width="2.2" stroke-linecap="round" class="dr"/>
  <g class="fi" style="animation-delay:900ms">${dots}</g>
  <line x1="${padL}" y1="${padT + ch}" x2="${W - padR}" y2="${padT + ch}" stroke="${T.line}"/>
  ${xTicks}
  ${tips}
</svg>`;
}

/* ─────────────────────────── card: bar chart (shadcn style) ─────────────────────────── */

/** Weekday commit distribution as rounded bars with value labels. */
function cardBarChart(dist) {
  const W = 440,
    H = 260;
  const padL = 38,
    padR = 18,
    padT = 58,
    padB = 38;
  const cw = W - padL - padR;
  const ch = H - padT - padB;

  if (!dist.known) {
    return `${svgOpen(W, H, 'weekday rhythm')}
  ${styleBlock()}
  ${shell(W, H, 'RHYTHM · BY WEEKDAY', 'AWAITING DATA')}
  <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${MONO}" font-size="10.5"
        letter-spacing="1.4" fill="${T.muted}">AWAITING CONTRIBUTION DATA</text>
</svg>`;
  }

  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  // Headroom so the value label above the tallest bar is never clipped.
  const max = Math.max(1, ...dist.values) * 1.14;
  const slot = cw / 7;
  const bw = Math.min(30, slot - 10);

  const peakVal = Math.max(...dist.values);
  const bars = dist.values
    .map((v, i) => {
      const h = Math.max(2, (v / max) * ch);
      const x = padL + i * slot + (slot - bw) / 2;
      const y = padT + ch - h;
      const isMax = v === peakVal;
      return `
    <g class="fi" style="animation-delay:${120 + i * 65}ms">
      <rect x="${x.toFixed(1)}" y="${padT}" width="${bw}" height="${ch}" rx="4" fill="${T.grid}" opacity="0.5"/>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="4"
            fill="${isMax ? T.redBright : T.red}"/>
      <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle"
            font-family="${MONO}" font-size="8.5" font-weight="700"
            fill="${isMax ? T.redBright : T.muted}">${v}</text>
      <text x="${(x + bw / 2).toFixed(1)}" y="${padT + ch + 16}" text-anchor="middle"
            font-family="${MONO}" font-size="9" fill="${T.muted}">${labels[i]}</text>
    </g>`;
    })
    .join('');

  const busiest = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][
    dist.values.indexOf(peakVal)
  ];

  return `${svgOpen(W, H, 'weekday rhythm')}
  ${styleBlock()}
  ${shell(W, H, 'RHYTHM · BY WEEKDAY', `${nf(dist.values.reduce((a, b) => a + b, 0))} TOTAL`)}
  <text x="20" y="50" font-family="${MONO}" font-size="8.5" letter-spacing="1.2" fill="${T.muted}">
    WHEN THE WORK HAPPENS
  </text>
  ${bars}
  <line x1="${padL}" y1="${padT + ch}" x2="${W - padR}" y2="${padT + ch}" stroke="${T.line}"/>
  <text x="20" y="${H - 12}" font-family="${MONO}" font-size="8" letter-spacing="1.1" fill="${T.muted}">
    BUSIEST <tspan fill="${T.red}" font-weight="700">${esc(busiest)}</tspan>
  </text>
</svg>`;
}

/* ─────────────────────────── card: radial breakdown ─────────────────────────── */

/** Contribution type split as a stacked donut with centered total. */
function cardDonut(mix) {
  const W = 440,
    H = 260;
  const cx = 132,
    cy = 152,
    r = 62,
    sw = 20;
  const circ = 2 * Math.PI * r;

  if (!mix.known) {
    return `${svgOpen(W, H, 'contribution mix')}
  ${styleBlock()}
  ${shell(W, H, 'BREAKDOWN · CONTRIBUTION MIX', 'AWAITING DATA')}
  <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="${MONO}" font-size="10.5"
        letter-spacing="1.4" fill="${T.muted}">AWAITING CONTRIBUTION DATA</text>
</svg>`;
  }

  const total = mix.parts.reduce((a, p) => a + p.value, 0) || 1;
  let offset = 0;
  const arcs = mix.parts
    .map((p, i) => {
      const frac = p.value / total;
      const len = frac * circ;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${RAMP[i]}"
        stroke-width="${sw}" stroke-dasharray="${len.toFixed(1)} ${(circ - len).toFixed(1)}"
        stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"
        class="fi" style="animation-delay:${150 + i * 110}ms"/>`;
      offset += len;
      return seg;
    })
    .join('');

  const legend = mix.parts
    .map(
      (p, i) => `
    <g class="fi" style="animation-delay:${260 + i * 90}ms">
      <rect x="238" y="${84 + i * 34}" width="10" height="10" rx="2" fill="${RAMP[i]}"/>
      <text x="256" y="${93 + i * 34}" font-family="${MONO}" font-size="10" fill="${T.text}">${esc(p.name)}</text>
      <text x="${W - 20}" y="${93 + i * 34}" text-anchor="end" font-family="${MONO}" font-size="10"
            font-weight="700" fill="${T.muted}">${nf(p.value)}</text>
    </g>`
    )
    .join('');

  return `${svgOpen(W, H, 'contribution mix')}
  ${styleBlock()}
  ${shell(W, H, 'BREAKDOWN · CONTRIBUTION MIX', 'LAST 12 MONTHS')}
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${T.panelAlt}" stroke-width="${sw}"/>
  ${arcs}
  <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="${MONO}" font-size="22"
        font-weight="700" fill="${T.text}">${esc(short(total))}</text>
  <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-family="${MONO}" font-size="7.5"
        letter-spacing="1.3" fill="${T.muted}">CONTRIBUTIONS</text>
  ${legend}
</svg>`;
}

/* ─────────────────────────── divider rule ─────────────────────────── */

/** Self-hosted section divider: red hairline with evidence-tape ticks. */
function cardRule() {
  const W = 880,
    H = 8;
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const x = 60 + i * 190;
    return `<rect x="${x}" y="1" width="26" height="6" fill="${T.red}" opacity="${0.9 - i * 0.13}"/>`;
  }).join('');
  return `${svgOpen(W, H, 'divider')}
  <rect x="0" y="3" width="${W}" height="2" fill="${T.redDeep}"/>
  <rect x="0" y="3" width="${W * 0.34}" height="2" fill="${T.red}"/>
  ${ticks}
</svg>`;
}

/* ─────────────────── README data tables (real interactivity) ─────────────────── */

/**
 * Writes the exact figures behind every chart into the README's collapsible
 * <details> block.
 *
 * GitHub serves README images through camo as <img>, so SVG :hover can never
 * fire — a real hover tooltip is impossible. A <details> block is the one
 * interaction GitHub does honour, so the precise numbers live there and are
 * regenerated alongside the cards to guarantee they match.
 */
function renderDataTables(d) {
  const rows = [];

  rows.push(`**Synced** \`${d.profile.syncedAt}\` · **Source** GitHub GraphQL API\n`);

  rows.push('#### Repositories\n');
  rows.push('| Metric | Count |');
  rows.push('| :-- | --: |');
  rows.push(`| Public repositories | ${nf(d.profile.counts.public)} |`);
  rows.push(`| Source (not forked) | ${nf(d.profile.counts.source)} |`);
  rows.push(`| Forked | ${nf(d.profile.counts.forked)} |`);
  rows.push(`| Stars earned | ${nf(d.profile.stars)} |`);
  rows.push(`| Forks of my work | ${nf(d.profile.forks)} |`);
  rows.push(`| Followers | ${nf(d.profile.followers)} |`);
  rows.push('');

  if (d.monthly.known) {
    rows.push('#### Contributions per month\n');
    rows.push(`| Month | ${d.monthly.points.map((p) => p.label).join(' | ')} |`);
    rows.push(`| :-- | ${d.monthly.points.map(() => '--:').join(' | ')} |`);
    rows.push(`| Count | ${d.monthly.points.map((p) => p.value).join(' | ')} |`);
    rows.push('');
  }

  if (d.weekday.known) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    rows.push('#### Contributions by weekday\n');
    rows.push(`| Day | ${names.join(' | ')} |`);
    rows.push(`| :-- | ${names.map(() => '--:').join(' | ')} |`);
    rows.push(`| Count | ${d.weekday.values.join(' | ')} |`);
    rows.push('');
  }

  if (d.mix.known) {
    const total = d.mix.parts.reduce((a, p) => a + p.value, 0) || 1;
    rows.push('#### Contribution mix\n');
    rows.push('| Type | Count | Share |');
    rows.push('| :-- | --: | --: |');
    for (const p of d.mix.parts) {
      rows.push(`| ${p.name} | ${nf(p.value)} | ${((p.value / total) * 100).toFixed(1)}% |`);
    }
    rows.push(`| **Total** | **${nf(total)}** | **100%** |`);
    rows.push('');
  }

  if (d.langs.length) {
    const total = d.langs.reduce((a, l) => a + l.value, 0) || 1;
    const unit = d.langUnit === 'bytes' ? 'Bytes' : 'Repos';
    rows.push('#### Languages\n');
    rows.push(`| Language | ${unit} | Share |`);
    rows.push('| :-- | --: | --: |');
    for (const l of d.langs.slice(0, 10)) {
      rows.push(`| ${l.name} | ${nf(l.value)} | ${((l.value / total) * 100).toFixed(1)}% |`);
    }
    rows.push('');
  }

  if (d.upstream.known) {
    rows.push('#### Upstream projects contributed to\n');
    rows.push('| Project | Stars | Merged | Open | Closed |');
    rows.push('| :-- | --: | --: | --: | --: |');
    for (const p of d.upstream.projects.slice(0, 20)) {
      rows.push(
        `| [${p.name}](https://github.com/${p.name}) | ${nf(p.stars)} | ${p.merged} | ${p.open} | ${p.closed} |`
      );
    }
    rows.push('');
  }

  if (d.streak.known) {
    rows.push('#### Streaks\n');
    rows.push('| Metric | Value |');
    rows.push('| :-- | --: |');
    rows.push(`| Current streak | ${d.streak.current} days |`);
    rows.push(`| Longest streak | ${d.streak.longest} days |`);
    rows.push(`| Active days (last year) | ${d.streak.activeDays} |`);
    rows.push(`| Total contributions | ${nf(d.streak.total)} |`);
    rows.push('');
  }

  const block = rows.join('\n');
  const README = 'README.md';
  const START = '<!-- DATA-TABLES:START -->';
  const END = '<!-- DATA-TABLES:END -->';

  if (!existsSync(README)) {
    console.warn('WARN: README.md not found — skipping data tables');
    return;
  }
  const md = readFileSync(README, 'utf8');
  const s = md.indexOf(START);
  const e = md.indexOf(END);
  if (s === -1 || e === -1) {
    console.warn('WARN: DATA-TABLES markers missing — skipping data tables');
    return;
  }
  const next = md.slice(0, s + START.length) + '\n\n' + block + '\n' + md.slice(e);
  if (next !== md) {
    writeFileSync(README, next, 'utf8');
    console.log(`updated ${README} data tables (${block.length} bytes)`);
  } else {
    console.log('data tables unchanged');
  }
}

/* ─────────────────────────── main ─────────────────────────── */

const d = await gather();
save('rule.svg', cardRule());
save('dossier.svg', cardDossier(d.profile));
save('languages.svg', cardLanguages(d.langs, d.langUnit));
save('streak.svg', cardStreak(d.streak));
save('heatmap.svg', cardHeatmap(d.cal));
save('repos.svg', cardRepos(d.topRepos));
save('upstream.svg', cardUpstream(d.upstream));
save('chart-area.svg', cardAreaChart(d.monthly));
save('chart-bars.svg', cardBarChart(d.weekday));
save('chart-donut.svg', cardDonut(d.mix));
save('quote.svg', cardQuote(d.profile.stamp));
renderDataTables(d);
console.log('\ncards generated in', OUT_DIR);
