import type { StudyWindow } from "./habits";
import { windowLabel } from "./habits";
import { firstSitting } from "./plan";
import type { Card, StudyLecture } from "./types";

/** 五箱：0 箱不用（答错走重学间隔），1 箱 10 分钟，2 箱 1 天，3 箱 3 天，4 箱 7 天。 */
export const CARD_GAPS = [0, 10 * 60 * 1000, 24 * 60 * 60 * 1000, 3 * 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

/** 答错后一分钟内再见一次，而不是原地无限重来。 */
export const RELEARN_MS = 60 * 1000;

export const MAX_DAY_MARKS = 40;
export const MAX_DAY_COUNT = 99;
export const MAX_MISSES = 40;

export type DayMark = {
  date: string;
  known: number;
  cards: number;
  quizzes: number;
};

export type Miss = {
  id: string;
  lectureId: string;
  prompt: string;
  explain: string;
  at: number;
};

export type DeskView = "talk" | "today" | "courses" | "class" | "knowledge" | "review";

export type DeskNavGroup = "now" | "library";

export const DESK_VIEWS: { id: DeskView; label: string; hint: string; group: DeskNavGroup }[] = [
  { id: "class", label: "上课", hint: "上传课件，老师按原文一句一句讲", group: "now" },
  { id: "talk", label: "对话", hint: "随时插话，追问老师", group: "now" },
  { id: "review", label: "复习", hint: "按科目看讲完留下的知识点", group: "now" },
  { id: "knowledge", label: "知识库", hint: "按科目、关键词查知识点", group: "library" },
];

export function todayKey(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function dayNumber(value: unknown): number {
  if (typeof value !== "number" || value <= 0) return 0;
  return Math.min(MAX_DAY_COUNT, Math.round(value));
}

export function normalizeDays(value: unknown): DayMark[] {
  if (!Array.isArray(value)) return [];
  const days: DayMark[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<DayMark>;
    if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) continue;
    days.push({
      date: raw.date,
      known: dayNumber(raw.known),
      cards: dayNumber(raw.cards),
      quizzes: dayNumber(raw.quizzes),
    });
    if (days.length >= MAX_DAY_MARKS) break;
  }
  return days;
}

export function normalizeMisses(value: unknown): Miss[] {
  if (!Array.isArray(value)) return [];
  const misses: Miss[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<Miss>;
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim().slice(0, 180) : "";
    const explain = typeof raw.explain === "string" ? raw.explain.trim().slice(0, 200) : "";
    const lectureId = typeof raw.lectureId === "string" ? raw.lectureId.slice(0, 80) : "";
    if (!prompt || !lectureId) continue;
    misses.push({
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 40) : `m${misses.length + 1}`,
      lectureId,
      prompt,
      explain,
      at: typeof raw.at === "number" ? raw.at : 0,
    });
    if (misses.length >= MAX_MISSES) break;
  }
  return misses;
}

export function bumpDay(days: DayMark[], field: keyof Omit<DayMark, "date">, now = new Date()): DayMark[] {
  const date = todayKey(now);
  const current = days.find((day) => day.date === date);
  const next = current
    ? days.map((day) =>
        day.date === date ? { ...day, [field]: Math.min(MAX_DAY_COUNT, day[field] + 1) } : day,
      )
    : [...days, { date, known: 0, cards: 0, quizzes: 0, [field]: 1 }];
  return next.slice(-MAX_DAY_MARKS);
}

function shiftDate(date: string, by: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const next = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  next.setDate(next.getDate() + by);
  return todayKey(next);
}

export function studyStreak(days: DayMark[], now = new Date()): number {
  const active = new Set(days.filter((day) => day.known + day.cards + day.quizzes > 0).map((day) => day.date));
  let cursor = todayKey(now);
  if (!active.has(cursor)) cursor = shiftDate(cursor, -1);
  let count = 0;
  while (active.has(cursor) && count < 400) {
    count += 1;
    cursor = shiftDate(cursor, -1);
  }
  return count;
}

export function todayMark(days: DayMark[], now = new Date()): DayMark {
  return days.find((day) => day.date === todayKey(now)) ?? { date: todayKey(now), known: 0, cards: 0, quizzes: 0 };
}

export type SittingPick = {
  lectureId: string;
  lectureTitle: string;
  subject: string;
  titles: string[];
  minutes: number;
};

export function todaySittings(lectures: StudyLecture[], minutes: number, slowTaps: number): SittingPick[] {
  const picks: SittingPick[] = [];
  for (const lecture of lectures) {
    if (lecture.units.length === 0) continue;
    const sitting = firstSitting(lecture.units, lecture.known, minutes, slowTaps);
    if (sitting.length === 0) continue;
    picks.push({
      lectureId: lecture.id,
      lectureTitle: lecture.title,
      subject: lecture.subject || "这一页",
      titles: sitting.map((unit) => unit.title),
      minutes: sitting.reduce((sum, unit) => sum + unit.minutes, 0),
    });
  }
  return picks;
}

export type DueCard = {
  lectureId: string;
  lectureTitle: string;
  card: Card;
};

export function collectDue(lectures: StudyLecture[], now: number): DueCard[] {
  const due: DueCard[] = [];
  for (const lecture of lectures) {
    for (const card of lecture.cards) {
      if (card.due <= now) due.push({ lectureId: lecture.id, lectureTitle: lecture.title, card });
    }
  }
  return due;
}

export function gradeCard(card: Card, remembered: boolean, now = Date.now()): Card {
  if (!remembered) return { ...card, box: 0, due: now + RELEARN_MS };
  const box = Math.min(CARD_GAPS.length - 1, card.box + 1);
  return { ...card, box, due: now + CARD_GAPS[box] };
}

export type CourseRoll = {
  subject: string;
  lectures: StudyLecture[];
  known: number;
  units: number;
  mustKnow: string[];
  pitfalls: string[];
  weak: string[];
};

export function rollCourses(lectures: StudyLecture[]): CourseRoll[] {
  const order: string[] = [];
  const groups = new Map<string, StudyLecture[]>();
  for (const lecture of lectures) {
    const subject = lecture.subject.trim() || "未分科";
    const list = groups.get(subject);
    if (list) list.push(lecture);
    else {
      groups.set(subject, [lecture]);
      order.push(subject);
    }
  }
  return order.map((subject) => {
    const rows = groups.get(subject) ?? [];
    const mustKnow: string[] = [];
    const pitfalls: string[] = [];
    const weak: string[] = [];
    let known = 0;
    let units = 0;
    for (const lecture of rows) {
      units += lecture.units.length;
      known += lecture.known.length;
      for (const item of lecture.summary.mustKnow) {
        if (!mustKnow.includes(item)) mustKnow.push(item);
      }
      for (const item of lecture.summary.pitfalls) {
        if (!pitfalls.includes(item)) pitfalls.push(item);
      }
      for (const unit of lecture.units) {
        if (!lecture.known.includes(unit.id) && unit.weight === "core" && weak.length < 4) {
          weak.push(unit.title);
        }
      }
    }
    return {
      subject,
      lectures: rows,
      known,
      units,
      mustKnow: mustKnow.slice(0, 5),
      pitfalls: pitfalls.slice(0, 4),
      weak,
    };
  });
}

export function courseBrief(course: CourseRoll): string {
  if (course.units === 0) return "这门还没拆成小讲。把课件给我，我再按页收进来。";
  const left = course.units - course.known;
  if (left <= 0) return "这门的小讲你都点过听懂了。复习里的卡片和错题，够把这门再收一遍。";
  const weak =
    course.weak.length > 0
      ? `还没听懂的会考处，先是${course.weak.slice(0, 2).map((title) => `「${title}」`).join("和")}。`
      : "";
  return `这门 ${course.lectures.length} 页，共 ${course.units} 个小讲，还剩 ${left} 个。${weak}`;
}

export function todayBrief(input: {
  name: string;
  window: StudyWindow;
  streak: number;
  sittings: number;
  due: number;
  misses: number;
  knownToday: number;
}): string {
  const who = input.name.trim();
  const hello = who ? `${who}，` : "";
  const when = windowLabel(input.window);
  if (input.sittings === 0 && input.due === 0 && input.misses === 0) {
    return `${hello}书桌上今天没有新的一坐，也没有到点的卡片。想上课，就再给我一页；想收，就把已经听过的再翻一翻。`;
  }
  const parts = [`${hello}你习惯${when}学。`];
  if (input.sittings > 0) parts.push(`今天还有 ${input.sittings} 页可以往下听。`);
  if (input.due > 0) parts.push(`${input.due} 张卡片到点了。`);
  if (input.misses > 0) parts.push(`错题本上还有 ${input.misses} 道。`);
  if (input.streak >= 2) parts.push(`这是连续第 ${input.streak} 天坐下。`);
  else if (input.knownToday > 0) parts.push("今天已经往前走了一点。");
  if (input.due > 0) parts.push("先把到点的卡片过完，再上课。");
  else if (input.misses > 0) parts.push("错的那几道，比新的一页更值得先看。");
  else parts.push("从还没听懂的那一小节开始就好。");
  return parts.join("");
}

export function mergeMisses(
  existing: Miss[],
  lectureId: string,
  items: { prompt: string; explain: string }[],
  now = Date.now(),
): Miss[] {
  const seen = new Set(existing.map((miss) => `${miss.lectureId}|${miss.prompt}`));
  const added: Miss[] = [];
  for (const item of items) {
    const prompt = item.prompt.trim();
    if (!prompt) continue;
    const key = `${lectureId}|${prompt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({
      id: `m${now}-${added.length}`,
      lectureId,
      prompt: prompt.slice(0, 180),
      explain: item.explain.trim().slice(0, 200),
      at: now,
    });
  }
  return [...added, ...existing].slice(0, MAX_MISSES);
}
