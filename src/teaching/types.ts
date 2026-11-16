export type Term = { word: string; meaning: string };

export type UnitWeight = "core" | "support";

export type Unit = {
  id: string;
  title: string;
  minutes: number;
  source: string;
  teaching: string;
  pause: string;
  terms: Term[];
  pitfall: string;
  weight: UnitWeight;
  example: string;
};

export type Summary = {
  outline: string[];
  mustKnow: string[];
  pitfalls: string[];
  mnemonic: string;
  recital: string;
};

export type Card = {
  id: string;
  front: string;
  back: string;
  box: number;
  due: number;
};

export type QuizItem = {
  id: string;
  prompt: string;
  choices: string[];
  answer: number;
  explain: string;
};

export type ChatMsg = { role: "user" | "tutor"; text: string };

/**
 * 复习与排课只依赖这些字段。Lecture 在此基础上再带 UI 状态，
 * 这样纯逻辑不必知道界面长什么样。
 */
export type StudyLecture = {
  id: string;
  title: string;
  subject: string;
  units: Unit[];
  known: string[];
  cards: Card[];
  summary: Summary;
};

export type Lecture = StudyLecture & {
  sourceName: string;
  hint: string;
  note: string;
  rawText: string;
  explainedThrough: number;
  greeting: string;
  thesis: string;
  tonight: string;
  nextSitting: string;
  habitStamp: string;
  quiz: QuizItem[];
  quizScore: { correct: number; total: number } | null;
  messages: ChatMsg[];
  checked: string[];
  cursor: number;
  createdAt: number;
  demo?: boolean;
};
