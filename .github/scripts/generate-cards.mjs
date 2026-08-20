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
  const stats = [
    ['COMMITS', g(d.commits)],
    ['PULL REQUESTS', g(d.prs)],
    ['REPOSITORIES', short(d.repos)],
    ['STARS EARNED', short(d.stars)],
    ['ISSUES CLOSED', g(d.issues)],
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
        letter-spacing="1.1" fill="${T.muted}">UPDATED ${esc(d.stamp)}</text>
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
    H = 205;
  const cell = 11,
    gap = 3,
    step = cell + gap;
  const gx = 46,
    gy = 80;

  let grid = '';
  let monthLabels = '';

  if (cal.known) {
    const weeks = cal.weeks;
    const max = Math.max(1, ...weeks.flatMap((w) => w.days.map((d) => d.count)));
    weeks.forEach((wk, wi) => {
      wk.days.forEach((day) => {
        let lvl = 0;
        if (day.count > 0) {
          const q = day.count / max;
          lvl = q > 0.66 ? 4 : q > 0.4 ? 3 : q > 0.15 ? 2 : 1;
        }
        grid += `<rect x="${gx + wi * step}" y="${gy + day.weekday * step}" width="${cell}" height="${cell}" rx="2.5" fill="${HEAT[lvl]}"/>`;
      });
      if (wk.firstOfMonth) {
        monthLabels += `<text x="${gx + wi * step}" y="${gy - 9}" font-family="${MONO}" font-size="8.5"
          letter-spacing="1" fill="${T.muted}">${esc(wk.firstOfMonth)}</text>`;
      }
    });
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
      `<rect x="${W - 128 + i * 15}" y="${H - 24}" width="11" height="11" rx="2.5" fill="${c}"/>`
  ).join('');

  return `${svgOpen(W, H, `${USER} — contribution spatter pattern`)}
  ${styleBlock()}
  ${shell(W, H, 'SPATTER PATTERN · 52 WEEKS', cal.known ? `${nf(cal.total)} CONTRIBUTIONS` : 'AWAITING DATA')}
  <text x="20" y="50" font-family="${MONO}" font-size="8.5" letter-spacing="1.2" fill="${T.muted}">
    EACH MARK IS ONE DAY OF EVIDENCE
  </text>
  ${monthLabels}
  ${dayLabels}
  <g class="fi" style="animation-delay:120ms">${grid}</g>
  <text x="${W - 146}" y="${H - 15}" text-anchor="end" font-family="${MONO}" font-size="8"
        letter-spacing="1.1" fill="${T.muted}">LESS</text>
  ${legend}
  <text x="${W - 20}" y="${H - 15}" text-anchor="end" font-family="${MONO}" font-size="8"
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

/* ─────────────────────────── data gathering ─────────────────────────── */

async function gather() {
  const user = await api(`/users/${USER}`);

  let repos = [];
  if (LOCAL_REPOS && existsSync(LOCAL_REPOS)) {
    repos = JSON.parse(readFileSync(LOCAL_REPOS, 'utf8'));
    console.log(`using cached repo list (${repos.length})`);
  } else {
    for (let page = 1; page <= 5; page++) {
      const batch = await api(`/users/${USER}/repos?per_page=100&page=${page}&sort=pushed`);
      repos.push(...batch);
      if (batch.length < 100) break;
    }
  }

  const owned = repos.filter((r) => !r.fork);
  const stars = owned.reduce((a, r) => a + r.stargazers_count, 0);
  const forks = owned.reduce((a, r) => a + r.forks_count, 0);

  /* languages: real byte counts when a token is available */
  let langs = [];
  let langUnit = 'bytes';
  if (TOKEN) {
    const totals = new Map();
    const targets = owned.filter((r) => r.language).slice(0, 60);
    for (const r of targets) {
      try {
        const bytes = await api(`/repos/${USER}/${r.name}/languages`);
        for (const [lang, n] of Object.entries(bytes)) {
          totals.set(lang, (totals.get(lang) || 0) + n);
        }
      } catch (e) {
        console.warn(`WARN: languages for ${r.name}: ${e.message}`);
      }
    }
    langs = [...totals].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }
  if (!langs.length) {
    const c = new Map();
    for (const r of owned) if (r.language) c.set(r.language, (c.get(r.language) || 0) + 1);
    langs = [...c].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    langUnit = 'repos';
    console.log('note: language card using repository counts (no token)');
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
          days: w.contributionDays.map((d) => ({ count: d.contributionCount, weekday: d.weekday })),
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
      stars: r.stargazers_count,
      forks: r.forks_count,
      lang: r.language,
    }))
    .sort((a, b) => b.stars - a.stars || b.forks - a.forks)
    .slice(0, 4);

  const created = new Date(user.created_at);
  return {
    profile: {
      name: user.name || user.login,
      gqKnown: Boolean(gq?.user),
      commits,
      prs,
      issues,
      repos: owned.length,
      stars,
      forks,
      followers: user.followers,
      since: created.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase(),
      caseNo: String(owned.length).padStart(3, '0'),
      stamp: new Date().toISOString().slice(0, 10),
    },
    langs,
    langUnit,
    streak,
    cal,
    monthly,
    weekday,
    mix,
    topRepos,
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

  return `${svgOpen(W, H, 'monthly contribution volume')}
  ${styleBlock(`.dr{stroke-dasharray:2600;stroke-dashoffset:0;animation:dr 1.5s ease-out forwards}
    @keyframes dr{from{stroke-dashoffset:2600}}`)}
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
  <line x1="${X(peakI).toFixed(1)}" y1="${padT}" x2="${X(peakI).toFixed(1)}" y2="${padT + ch}"
        stroke="${T.redBright}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>
  <g class="fi" style="animation-delay:900ms">${dots}</g>
  <line x1="${padL}" y1="${padT + ch}" x2="${W - padR}" y2="${padT + ch}" stroke="${T.line}"/>
  ${xTicks}
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

/* ─────────────────────────── main ─────────────────────────── */

const d = await gather();
save('rule.svg', cardRule());
save('dossier.svg', cardDossier(d.profile));
save('languages.svg', cardLanguages(d.langs, d.langUnit));
save('streak.svg', cardStreak(d.streak));
save('heatmap.svg', cardHeatmap(d.cal));
save('repos.svg', cardRepos(d.topRepos));
save('chart-area.svg', cardAreaChart(d.monthly));
save('chart-bars.svg', cardBarChart(d.weekday));
save('chart-donut.svg', cardDonut(d.mix));
console.log('\ncards generated in', OUT_DIR);
