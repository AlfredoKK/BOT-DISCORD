const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const { getWeekDaysSunday, formatDate, DAY_ABBREVS } = require('./date-utils');

// Register font
const FONT_PATHS = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
];
for (const fp of FONT_PATHS) {
  if (fs.existsSync(fp)) {
    GlobalFonts.registerFromPath(fp, 'Agenda');
    break;
  }
}
const FONT = GlobalFonts.has('Agenda') ? 'Agenda' : 'Arial, Helvetica, sans-serif';

// ── Layout (extra-wide for Discord readability) ──
const HOUR_START = 7;
const HOUR_END = 21;
const HOURS_COUNT = HOUR_END - HOUR_START;

const COL_WIDTH = 360;
const HOUR_HEIGHT = 120;
const HEADER_HEIGHT = 95;
const TIME_COL_WIDTH = 82;

const CANVAS_WIDTH = TIME_COL_WIDTH + COL_WIDTH * 7 + 1;
const CANVAS_HEIGHT = HEADER_HEIGHT + HOUR_HEIGHT * HOURS_COUNT + 1;

// ── Theme ──
const BG = '#121212';
const HEADER_BG = '#1e1e1e';
const GRID_LINE = '#333333';
const GRID_HALF = '#282828';
const LABEL_COLOR = '#9e9e9e';
const DAY_NUM_COLOR = '#e0e0e0';
const TODAY_CIRCLE = '#4285f4';

// Fallback Google Calendar event colors
const FALLBACK_COLORS = {
  '1': '#a4bdfc', '2': '#7ae7bf', '3': '#dbadff', '4': '#ff887c',
  '5': '#fbd75b', '6': '#ffb878', '7': '#46d6db', '8': '#e1e1e1',
  '9': '#5484ed', '10': '#51b749', '11': '#dc2127',
};

// ── Color helpers ──
function hexToRgb(hex) {
  const h = (hex || '#039be5').replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16) || 0,
    g: parseInt(h.substring(2, 4), 16) || 0,
    b: parseInt(h.substring(4, 6), 16) || 0,
  };
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function fgColor(bg) { return luminance(bg) > 0.55 ? '#1a1a1a' : '#ffffff'; }
function fgSub(bg) { return luminance(bg) > 0.55 ? '#444' : 'rgba(255,255,255,0.75)'; }

function darken(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = 1 - amt;
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

function getEventColor(event, colorMap, calDefault) {
  if (event.colorId && colorMap[event.colorId]) return colorMap[event.colorId];
  if (calDefault) return calDefault;
  return '#039be5';
}

// ── Geometry helpers ──
function timeToY(date) {
  return HEADER_HEIGHT + (date.getHours() + date.getMinutes() / 60 - HOUR_START) * HOUR_HEIGHT;
}

function isToday(d) {
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function truncate(ctx, text, maxW) {
  if (!text || maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.length > 0 ? t + '…' : '';
}

function wrapLines(ctx, text, maxW, maxLines) {
  if (!text || maxW <= 10) return [text || ''];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length > 0) lines[lines.length - 1] = truncate(ctx, lines[lines.length - 1], maxW);
  return lines.length > 0 ? lines : [''];
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(Math.max(r, 0), w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Column assignment (like Google Calendar) ──
function assignColumns(sortedEvents) {
  const colEnds = []; // end timestamp per column
  const result = [];

  for (const event of sortedEvents) {
    const start = new Date(event.start.dateTime).getTime();
    const end = getEnd(event).getTime();

    let col = -1;
    for (let c = 0; c < colEnds.length; c++) {
      if (colEnds[c] <= start) { col = c; break; }
    }
    if (col === -1) { col = colEnds.length; colEnds.push(0); }
    colEnds[col] = end;
    result.push({ event, col, start: new Date(event.start.dateTime), end: getEnd(event) });
  }

  return { items: result, maxCols: colEnds.length };
}

function getEnd(event) {
  if (event.end && event.end.dateTime) return new Date(event.end.dateTime);
  return new Date(new Date(event.start.dateTime).getTime() + 30 * 60000);
}

// ═══════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════
function generateAgendaImage(sunday, events, colorMap, calendarDefaultColor) {
  const colors = colorMap || FALLBACK_COLORS;
  const days = getWeekDaysSunday(sunday);
  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  // ── Background ──
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // ── Header ──
  ctx.fillStyle = HEADER_BG;
  ctx.fillRect(0, 0, CANVAS_WIDTH, HEADER_HEIGHT);
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT - 0.5);
  ctx.lineTo(CANVAS_WIDTH, HEADER_HEIGHT - 0.5);
  ctx.stroke();

  for (let i = 0; i < 7; i++) {
    const cx = TIME_COL_WIDTH + i * COL_WIDTH + COL_WIDTH / 2;
    const dayDate = days[i];

    // Day abbreviation
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = `600 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(DAY_ABBREVS[dayDate.getDay()], cx, 28);

    // Full date: DD/MM
    const dd = String(dayDate.getDate()).padStart(2, '0');
    const mm = String(dayDate.getMonth() + 1).padStart(2, '0');
    const dateLabel = `${dd}/${mm}`;
    if (isToday(dayDate)) {
      // Blue rounded-rect background
      ctx.fillStyle = TODAY_CIRCLE;
      const tw = ctx.measureText(dateLabel).width;
      roundRect(ctx, cx - tw / 2 - 10, 38, tw + 20, 34, 17);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 22px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(dateLabel, cx, 55);
    } else {
      ctx.fillStyle = DAY_NUM_COLOR;
      ctx.font = `400 22px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(dateLabel, cx, 55);
    }

    // Vertical separators
    if (i > 0) {
      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(TIME_COL_WIDTH + i * COL_WIDTH + 0.5, HEADER_HEIGHT);
      ctx.lineTo(TIME_COL_WIDTH + i * COL_WIDTH + 0.5, CANVAS_HEIGHT);
      ctx.stroke();
    }
  }

  // ── GMT label ──
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('GMT+01', 6, HEADER_HEIGHT + 17);

  // ── Grid ──
  for (let h = 0; h <= HOURS_COUNT; h++) {
    const y = HEADER_HEIGHT + h * HOUR_HEIGHT;

    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(TIME_COL_WIDTH, y + 0.5);
    ctx.lineTo(CANVAS_WIDTH, y + 0.5);
    ctx.stroke();

    if (h < HOURS_COUNT) {
      // Half-hour dashed
      ctx.strokeStyle = GRID_HALF;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(TIME_COL_WIDTH, y + HOUR_HEIGHT / 2 + 0.5);
      ctx.lineTo(CANVAS_WIDTH, y + HOUR_HEIGHT / 2 + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      // Time label
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = `14px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${String(HOUR_START + h).padStart(2, '0')}:00`, TIME_COL_WIDTH - 10, y + 16);
    }
  }

  // Left border
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(TIME_COL_WIDTH + 0.5, HEADER_HEIGHT);
  ctx.lineTo(TIME_COL_WIDTH + 0.5, CANVAS_HEIGHT);
  ctx.stroke();

  // ── Organize events by day ──
  const eventsByDay = Array.from({ length: 7 }, () => []);
  for (const ev of events) {
    if (!ev.start || !ev.start.dateTime) continue;
    const s = new Date(ev.start.dateTime);
    const idx = days.findIndex(
      (d) => d.getFullYear() === s.getFullYear() && d.getMonth() === s.getMonth() && d.getDate() === s.getDate()
    );
    if (idx !== -1) eventsByDay[idx].push(ev);
  }
  for (const arr of eventsByDay) {
    arr.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
  }

  // ── Draw events ──
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    if (eventsByDay[dayIdx].length === 0) continue;
    const colX = TIME_COL_WIDTH + dayIdx * COL_WIDTH;
    const { items, maxCols } = assignColumns(eventsByDay[dayIdx]);

    const usable = COL_WIDTH - 6; // 3px padding each side
    const slotW = usable / maxCols;

    // Draw in column order (col 0 first) so later columns appear on top
    const sorted = [...items].sort((a, b) => a.col - b.col);

    for (const { event, col, start, end } of sorted) {
      const ex = colX + 3 + col * slotW;
      const ew = slotW - 2;
      if (ew < 8) continue;

      const y1raw = timeToY(start);
      const y2raw = timeToY(end);
      // Clamp: events must not bleed into the header area
      const ey = Math.max(y1raw, HEADER_HEIGHT + 1);
      const eh = Math.max(y2raw - ey, 24);
      if (ey + eh < HEADER_HEIGHT || ey > CANVAS_HEIGHT) continue;

      const bg = getEventColor(event, colors, calendarDefaultColor);

      // ── Shadow for separation ──
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      roundRect(ctx, ex - 0.5, ey - 0.5, ew + 1, eh + 1, 5);
      ctx.fill();

      // ── Main fill ──
      ctx.fillStyle = bg;
      roundRect(ctx, ex, ey, ew, eh, 4);
      ctx.fill();

      // ── Left accent bar (4px, darker) ──
      ctx.fillStyle = darken(bg, 0.3);
      ctx.fillRect(ex + 1, ey + 4, 3, eh - 8);

      // ── Text ──
      ctx.save();
      ctx.beginPath();
      ctx.rect(ex + 5, ey, ew - 5, eh);
      ctx.clip();

      const title = event.summary || 'Sans titre';
      const sH = String(start.getHours()).padStart(2, '0');
      const sM = String(start.getMinutes()).padStart(2, '0');
      const eH = String(end.getHours()).padStart(2, '0');
      const eM = String(end.getMinutes()).padStart(2, '0');
      const timeLabel = `De ${sH}:${sM} à ${eH}:${eM}`;

      const fg1 = fgColor(bg);
      const fg2 = fgSub(bg);
      const px = 8;
      const maxW = ew - px - 4;

      if (ew < 35) {
        // ── Ultra-narrow: just first initial or short word ──
        ctx.fillStyle = fg1;
        ctx.font = `bold 11px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        // Show first word of title vertically-ish (line by line)
        const firstWord = title.split(/[\s\-]+/)[0] || '';
        const chars = firstWord.substring(0, Math.floor(eh / 12));
        let cy = ey + 12;
        for (const ch of chars) {
          ctx.fillText(ch, ex + 6, cy);
          cy += 11;
        }
      } else if (ew < 70) {
        // ── Narrow: title only, truncated ──
        ctx.fillStyle = fg1;
        ctx.font = `bold 12px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        if (eh < 30) {
          ctx.textBaseline = 'middle';
          ctx.fillText(truncate(ctx, title, maxW), ex + px, ey + eh / 2);
        } else {
          // Wrap title in available height
          const lineH = 14;
          const maxLines = Math.max(1, Math.floor((eh - 4) / lineH));
          const lines = wrapLines(ctx, title, maxW, maxLines);
          let ty = ey + 14;
          for (const line of lines) {
            ctx.fillText(line, ex + px, ty);
            ty += lineH;
          }
        }
      } else {
        // ── Normal/wide: full title + time ──
        if (eh < 32) {
          // Tiny height: one line
          ctx.fillStyle = fg1;
          ctx.font = `bold 13px ${FONT}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(truncate(ctx, title, maxW), ex + px, ey + eh / 2);
        } else if (eh < 52) {
          // Short: title + time on 2 lines
          ctx.fillStyle = fg1;
          ctx.font = `bold 14px ${FONT}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(truncate(ctx, title, maxW), ex + px, ey + 18);
          ctx.fillStyle = fg2;
          ctx.font = `12px ${FONT}`;
          ctx.fillText(truncate(ctx, timeLabel, maxW), ex + px, ey + 36);
        } else {
          // Tall: wrapped title + time
          const lineH = 18;
          const maxTitleLines = Math.max(1, Math.min(Math.floor((eh - 30) / lineH), 6));

          ctx.fillStyle = fg1;
          ctx.font = `bold 14px ${FONT}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          const titleLines = wrapLines(ctx, title, maxW, maxTitleLines);
          let ty = ey + 19;
          for (const line of titleLines) {
            ctx.fillText(line, ex + px, ty);
            ty += lineH;
          }
          // Time
          if (ty + 6 < ey + eh) {
            ctx.fillStyle = fg2;
            ctx.font = `13px ${FONT}`;
            ctx.fillText(truncate(ctx, timeLabel, maxW), ex + px, ty + 3);
          }
        }
      }

      ctx.restore();
    }
  }

  // ── Current time red line ──
  const now = new Date();
  const todayIdx = days.findIndex((d) => isToday(d));
  if (todayIdx !== -1) {
    const frac = now.getHours() + now.getMinutes() / 60;
    if (frac >= HOUR_START && frac <= HOUR_END) {
      const yNow = HEADER_HEIGHT + (frac - HOUR_START) * HOUR_HEIGHT;
      const xStart = TIME_COL_WIDTH + todayIdx * COL_WIDTH;

      ctx.beginPath();
      ctx.arc(xStart + 3, yNow, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ea4335';
      ctx.fill();

      ctx.strokeStyle = '#ea4335';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(xStart + 9, yNow);
      ctx.lineTo(xStart + COL_WIDTH, yNow);
      ctx.stroke();
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateAgendaImage };
