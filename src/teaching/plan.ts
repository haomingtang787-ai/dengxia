import type { Habits, StudyWindow } from "./habits";
import { windowLabel } from "./habits";

export type PlanUnit = {
  id: string;
  title: string;
  minutes: number;
  weight: "core" | "support";
};

export type RhythmDay = {
  label: string;
  detail: string;
  titles: string[];
};

export type Rhythm = {
  days: RhythmDay[];
  aside: string[];
  note: string;
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function parseISODate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1) {
    return null;
  }
  return date;
}

export function joinTitles(titles: string[]): string {
  const wrapped = titles.map((title) => `「${title}」`);
  if (wrapped.length <= 1) return wrapped[0] ?? "";
  if (wrapped.length === 2) return `${wrapped[0]}和${wrapped[1]}`;
  return `${wrapped.slice(0, -1).join("、")}和${wrapped[wrapped.length - 1]}`;
}

function windowPhrase(window: StudyWindow): string {
  if (window === "morning") return "今天早上";
  if (window === "afternoon") return "今天下午";
  if (window === "night") return "今晚睡前";
  return "今天晚上";
}

/**
 * 这一坐：从还没听懂的小讲里，按分钟数从前往后装。
 * 连续两次点「放慢」时只取一讲，且措辞与 `sittingSentence` 的「只上」一致。
 * 第一讲本身超过一坐也要给它一讲，不能让用户看到空的一坐。
 */
export function firstSitting(
  units: PlanUnit[],
  knownIds: string[],
  minutes: number,
  slowTaps: number,
): PlanUnit[] {
  const remaining = units.filter((unit) => !knownIds.includes(unit.id));
  if (remaining.length === 0) return [];
  if (slowTaps >= 2) return remaining.slice(0, 1);
  const slot = minutes;
  const picked: PlanUnit[] = [];
  let load = 0;
  for (const unit of remaining) {
    if (picked.length > 0 && load + unit.minutes > slot) break;
    picked.push(unit);
    load += unit.minutes;
  }
  return picked;
}

export function sittingSentence(
  sitting: PlanUnit[],
  habits: Habits,
  slowTaps: number,
  allKnown: boolean,
): string {
  const when = windowPhrase(habits.window);
  if (allKnown) {
    return `这一页你都点过听懂了。${when}可以不听新的，去练习里用题和卡片收一收。`;
  }
  if (sitting.length === 0) return "这一页还没有拆成小讲。把课件给我，我来拆。";
  const mins = sitting.reduce((sum, unit) => sum + unit.minutes, 0);
  const names = joinTitles(sitting.map((unit) => unit.title));
  if (slowTaps >= 2) {
    return `你希望我放慢，所以${when}只上${names}，大约 ${mins} 分钟。`;
  }
  return `按你每次 ${habits.minutes} 分钟、习惯${windowLabel(habits.window)}学，${when}先上${names}，大约 ${mins} 分钟。`;
}

function dayLabel(offset: number, window: StudyWindow, today: Date, examOffset: number | null): string {
  if (examOffset !== null && offset === examOffset) return "考试日";
  const word = windowLabel(window);
  if (offset === 0) {
    if (window === "morning") return "今天早上";
    if (window === "afternoon") return "今天下午";
    if (window === "night") return "今晚睡前";
    return "今天晚上";
  }
  if (offset === 1) {
    if (window === "morning") return "明天早上";
    if (window === "afternoon") return "明天下午";
    if (window === "night") return "明晚睡前";
    return "明天晚上";
  }
  const date = addDays(startOfDay(today), offset);
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${word}`;
}

function packStrict(items: PlanUnit[], days: number, slotMin: number) {
  const count = Math.max(days, 1);
  const buckets: PlanUnit[][] = Array.from({ length: count }, () => []);
  const loads = Array.from({ length: count }, () => 0);
  const leftover: PlanUnit[] = [];
  let day = 0;
  for (const item of items) {
    while (day < count && loads[day] > 0 && loads[day] + item.minutes > slotMin) day += 1;
    if (day >= count) leftover.push(item);
    else {
      buckets[day].push(item);
      loads[day] += item.minutes;
    }
  }
  return { buckets, leftover };
}

export function buildRhythm(options: {
  units: PlanUnit[];
  knownIds: string[];
  habits: Habits;
  slowTaps: number;
  examDate: string;
  today: Date;
}): Rhythm {
  const { units, knownIds, habits, slowTaps, examDate, today } = options;
  const remaining = units.filter((unit) => !knownIds.includes(unit.id));
  const word = windowLabel(habits.window);
  if (remaining.length === 0) {
    return {
      days: [],
      aside: [],
      note: `这一页都听懂了。${word}不用再上新的，练习里的题和卡片够收一收。`,
    };
  }

  const today0 = startOfDay(today);
  const exam = parseISODate(examDate);
  let past = false;
  let span = 6;
  if (exam) {
    const diff = Math.round((startOfDay(exam).getTime() - today0.getTime()) / 86400000);
    if (diff < 0) {
      past = true;
      span = 4;
    } else {
      span = Math.min(14, diff + 1);
    }
  }

  const reviewOnExam = Boolean(exam) && !past && span >= 3;
  const studySpan = reviewOnExam ? span - 1 : span;
  const slow = slowTaps >= 2;
  const slot = slow ? remaining[0].minutes : habits.minutes;
  const totalMin = remaining.reduce((sum, unit) => sum + unit.minutes, 0);
  const capacity = studySpan * slot;
  const tight = totalMin > capacity;

  let pool = remaining;
  const aside = new Set<string>();
  if (tight) {
    const core = remaining.filter((unit) => unit.weight === "core");
    const support = remaining.filter((unit) => unit.weight !== "core");
    const coreMin = core.reduce((sum, unit) => sum + unit.minutes, 0);
    if (core.length > 0 && coreMin <= capacity) {
      pool = core;
      for (const unit of support) aside.add(unit.title);
    }
  }

  const packed = packStrict(pool, studySpan, slot);
  for (const item of packed.leftover) aside.add(item.title);

  const days: RhythmDay[] = [];
  packed.buckets.forEach((bucket, offset) => {
    if (bucket.length === 0) return;
    const mins = bucket.reduce((sum, unit) => sum + unit.minutes, 0);
    days.push({
      label: dayLabel(offset, habits.window, today, null),
      detail: `大约 ${mins} 分钟`,
      titles: bucket.map((unit) => unit.title),
    });
  });

  if (reviewOnExam) {
    days.push({
      label: "考试日",
      detail: "不讲新的",
      titles: ["把还没听懂的，和到期的卡片，再过一遍"],
    });
  }

  let note = `按你每次 ${habits.minutes} 分钟、习惯${word}学来排。点过听懂的小讲，会从进度里让开。`;
  if (!exam) {
    note = `还没填考试日。我先按每次 ${habits.minutes} 分钟，排进接下来几个${word}。`;
    if (slow) note += "你希望放慢，所以每天一小讲。";
  } else if (past) {
    note = `考试日已经过了。我们不赶，仍按每次 ${habits.minutes} 分钟把剩下的听完。`;
  } else if (tight) {
    note = "日子有些紧。必考的小讲排在前面，来不及细讲的放在选读，你有精神再听。";
  } else if (slow) {
    note = `你希望我放慢，每天只排一小讲，习惯${word}学。`;
  }

  return { days, aside: [...aside], note };
}
