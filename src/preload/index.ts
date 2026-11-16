import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { JobChangedEvent, PreviewFocus, Result } from '../shared/contract'
import { IpcChannel } from '../shared/ipc'

function invoke<T>(channel: string, body?: unknown): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, body) as Promise<Result<T>>
}

const desk = {
  documents: {
    pick: () => invoke<import('../shared/contract').PickResult>(IpcChannel.documentsPick, {}),
    import: (body: { handle: string; requestId: string }) =>
      invoke<import('../shared/contract').ImportResult>(IpcChannel.documentsImport, body),
    list: (body: { offset?: number; limit?: number } = {}) =>
      invoke<import('../shared/contract').DocumentList>(IpcChannel.documentsList, body),
    get: (body: { documentVersionId: string }) =>
      invoke<import('../shared/contract').DocumentDetail>(IpcChannel.documentsGet, body),
    pages: (body: { documentVersionId: string; offset?: number; limit?: number }) =>
      invoke<import('../shared/contract').PageList>(IpcChannel.documentsPages, body),
    blocks: (body: { pageId?: string; documentVersionId?: string; scope?: 'unpaged'; offset?: number; limit?: number }) =>
      invoke<import('../shared/contract').BlockList>(IpcChannel.documentsBlocks, body),
    openSource: (locator: import('../shared/contract').Locator) =>
      invoke<import('../shared/contract').OpenSourceResult>(IpcChannel.documentsOpenSource, locator),
  },
  jobs: {
    get: (body: { jobId: string }) => invoke<import('../shared/contract').JobSnapshot>(IpcChannel.jobsGet, body),
    cancel: (body: { jobId: string }) => invoke<{ state: string }>(IpcChannel.jobsCancel, body),
    retry: (body: { jobId: string; requestId: string }) => invoke<{ jobId: string }>(IpcChannel.jobsRetry, body),
    onChanged: (callback: (event: JobChangedEvent) => void) => {
      const listener = (_event: IpcRendererEvent, payload: JobChangedEvent) => callback(payload)
      ipcRenderer.on(IpcChannel.jobsChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannel.jobsChanged, listener)
    },
  },
  prerequisites: {
    get: () => invoke<import('../shared/contract').Prerequisites>(IpcChannel.prerequisitesGet, {}),
    pickLibreOffice: () => invoke<import('../shared/contract').Prerequisites>(IpcChannel.prerequisitesPickLibreOffice, {}),
    recheck: () => invoke<import('../shared/contract').Prerequisites>(IpcChannel.prerequisitesRecheck, {}),
  },
  teaching: {
    habits: {
      get: () => invoke<import('../shared/teaching').HabitsView>(IpcChannel.teachingHabitsGet, {}),
      save: (body: import('../shared/teaching').HabitsView) =>
        invoke<import('../shared/teaching').HabitsView>(IpcChannel.teachingHabitsSave, body),
    },
    lectures: {
      create: (body: import('../shared/teaching').CreateLectureBody) =>
        invoke<import('../shared/teaching').LectureListItem>(IpcChannel.teachingLecturesCreate, body),
      list: () => invoke<import('../shared/teaching').LectureList>(IpcChannel.teachingLecturesList, {}),
      get: (body: { lectureId: string }) =>
        invoke<import('../shared/teaching').LectureDetail>(IpcChannel.teachingLecturesGet, body),
    },
    markKnown: (body: { lectureId: string; unitId: string; known: boolean }) =>
      invoke<{ known: string[] }>(IpcChannel.teachingMarkKnown, body),
    setCursor: (body: { lectureId: string; cursor: number }) =>
      invoke<{ cursor: number }>(IpcChannel.teachingSetCursor, body),
    dueCards: () => invoke<import('../shared/teaching').DueCardList>(IpcChannel.teachingDueCards, {}),
    gradeCard: (body: { lectureId: string; cardId: string; remembered: boolean }) =>
      invoke<import('../shared/teaching').GradeCardResult>(IpcChannel.teachingGradeCard, body),
    answerQuiz: (body: { lectureId: string; quizId: string; choice: number }) =>
      invoke<import('../shared/teaching').QuizAnswerResult>(IpcChannel.teachingAnswerQuiz, body),
    misses: (body: { limit?: number } = {}) =>
      invoke<import('../shared/teaching').MissList>(IpcChannel.teachingMisses, body),
    today: () => invoke<import('../shared/teaching').DayMarkView>(IpcChannel.teachingToday, {}),
    note: (body: { lectureId: string }) =>
      invoke<{ text: string }>(IpcChannel.teachingNote, body),
  },
  ai: {
    status: () => invoke<import('../shared/ai').AiConfigView>(IpcChannel.aiStatus, {}),
    saveConfig: (body: { baseUrl: string; model: string; visionModel?: string; apiKey: string }) =>
      invoke<import('../shared/ai').AiConfigView>(IpcChannel.aiSaveConfig, body),
    test: () => invoke<import('../shared/ai').AiTestResult>(IpcChannel.aiTest, {}),
    makeLecture: (body: {
      requestId: string
      documentVersionId: string
      title: string
      subject: string
      sourceName: string
      pageLabel?: string
      blocks: Array<{ kind: string; text: string }>
    }) => invoke<import('../shared/teaching').LectureListItem>(IpcChannel.aiMakeLecture, body),
    models: (body: { baseUrl?: string; apiKey?: string } = {}) =>
      invoke<import('../shared/ai').AiModelList>(IpcChannel.aiModels, body),
  },
  images: {
    readings: (body: { documentVersionId: string }) =>
      invoke<import('../shared/images').ImageReadingList>(IpcChannel.imagesReadings, body),
    ocr: (body: { documentVersionId: string; pageId: string }) =>
      invoke<import('../shared/images').ImageReadingResult>(IpcChannel.imagesOcr, body),
    vision: (body: { documentVersionId: string; pageId: string }) =>
      invoke<import('../shared/images').ImageReadingResult>(IpcChannel.imagesVision, body),
    auto: (body: { documentVersionId: string; pageId: string }) =>
      invoke<import('../shared/images').AutoReadResult>(IpcChannel.imagesAuto, body),
  },
  research: {
    list: (body: { documentVersionId: string }) =>
      invoke<import('../shared/research').ResearchList>(IpcChannel.researchList, body),
    verify: (body: { documentVersionId: string; pageId: string; query?: string }) =>
      invoke<import('../shared/research').ResearchResult>(IpcChannel.researchVerify, body),
  },
  study: {
    create: (body: { requestId: string; documentVersionId: string; title?: string; subject?: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyCreate, body),
    list: () => invoke<import('../shared/study').StudySessionList>(IpcChannel.studyList, {}),
    get: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyGet, body),
    send: (body: { sessionId: string; content: string; unitOrdinal?: number | null }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studySend, body),
    finish: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyFinish, body),
    check: (body: { sessionId: string; unitOrdinal: number; segmentIndex: number; answer: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyCheck, body),
    onProgress: (callback: (progress: import('../shared/study').StudyProgress) => void) => {
      const listener = (_event: IpcRendererEvent, payload: import('../shared/study').StudyProgress) => callback(payload)
      ipcRenderer.on(IpcChannel.studyProgress, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.studyProgress, listener)
      }
    },
  },
  preview: {
    onFocus: (callback: (focus: PreviewFocus) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PreviewFocus) => callback(payload)
      ipcRenderer.on(IpcChannel.previewFocus, listener)
      return () => ipcRenderer.removeListener(IpcChannel.previewFocus, listener)
    },
  },
  app: {
    info: () => invoke<import('../shared/app').AppInfo>(IpcChannel.appInfo, {}),
    checkUpdate: () => invoke<import('../shared/app').UpdateCheckResult>(IpcChannel.appCheckUpdate, {}),
  },
}

contextBridge.exposeInMainWorld('desk', desk)

export type DeskApi = typeof desk
