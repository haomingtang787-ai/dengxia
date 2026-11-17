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
    list: (body: { offset?: number; limit?: number; query?: string; format?: string } = {}) =>
      invoke<import('../shared/contract').DocumentList>(IpcChannel.documentsList, body),
    get: (body: { documentVersionId: string }) =>
      invoke<import('../shared/contract').DocumentDetail>(IpcChannel.documentsGet, body),
    pages: (body: { documentVersionId: string; offset?: number; limit?: number }) =>
      invoke<import('../shared/contract').PageList>(IpcChannel.documentsPages, body),
    blocks: (body: { pageId?: string; documentVersionId?: string; scope?: 'unpaged'; offset?: number; limit?: number }) =>
      invoke<import('../shared/contract').BlockList>(IpcChannel.documentsBlocks, body),
    openSource: (locator: import('../shared/contract').Locator) =>
      invoke<import('../shared/contract').OpenSourceResult>(IpcChannel.documentsOpenSource, locator),
    delete: (body: { documentVersionId: string }) =>
      invoke<import('../shared/contract').DeleteDocumentResult>(IpcChannel.documentsDelete, body),
    search: (body: { query: string; limit?: number; offset?: number }) =>
      invoke<import('../shared/search').SearchList>(IpcChannel.documentsSearch, body),
    highlights: (body: { documentVersionId: string }) =>
      invoke<import('../shared/highlights').HighlightList>(IpcChannel.documentsHighlights, body),
    createHighlight: (body: import('../shared/highlights').HighlightCreateBody) =>
      invoke<import('../shared/highlights').HighlightView>(IpcChannel.documentsHighlightCreate, body),
    deleteHighlight: (body: { id: string }) =>
      invoke<{ deleted: boolean }>(IpcChannel.documentsHighlightDelete, body),
    cleanupHighlights: (body: { documentVersionId: string }) =>
      invoke<{ deleted: number }>(IpcChannel.documentsHighlightCleanup, body),
    rename: (body: { documentVersionId: string; displayName: string }) =>
      invoke<{ documentId: string; displayName: string }>(IpcChannel.documentsRename, body),
    pin: (body: { documentVersionId: string; pinned: boolean }) =>
      invoke<{ pinned: boolean }>(IpcChannel.documentsPin, body),
  },
  review: {
    settings: () => invoke<import('../shared/contract').ReviewSettingsView>(IpcChannel.reviewSettingsGet, {}),
    saveSettings: (body: import('../shared/contract').ReviewSettingsView) =>
      invoke<import('../shared/contract').ReviewSettingsView>(IpcChannel.reviewSettingsSave, body),
  },
  data: {
    storage: () => invoke<import('../shared/contract').StorageUsage>(IpcChannel.dataStorage, {}),
    stats: () => invoke<import('../shared/contract').LibraryStats>(IpcChannel.dataStats, {}),
    backup: () => invoke<import('../shared/contract').BackupResult>(IpcChannel.dataBackup, {}),
    pickBackupDir: () => invoke<import('../shared/data').PickBackupDirResult>(IpcChannel.dataBackupPickDir, {}),
    autoBackup: () => invoke<import('../shared/data').AutoBackupResult>(IpcChannel.dataAutoBackup, {}),
    inspectRestore: () => invoke<import('../shared/data').RestorePreview>(IpcChannel.dataRestoreInspect, {}),
    applyRestore: (body: { token: string }) => invoke<import('../shared/data').RestoreApplied>(IpcChannel.dataRestoreApply, body),
    settings: () => invoke<import('../shared/data').AppSettingsView>(IpcChannel.dataSettingsGet, {}),
    saveSettings: (body: import('../shared/data').SaveAppSettingsBody) =>
      invoke<import('../shared/data').AppSettingsView>(IpcChannel.dataSettingsSave, body),
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
    cards: {
      list: () => invoke<import('../shared/teaching').CardList>(IpcChannel.teachingCardsList, {}),
      create: (body: import('../shared/teaching').CardCreateBody) =>
        invoke<import('../shared/teaching').TeachingCard>(IpcChannel.teachingCardCreate, body),
      edit: (body: import('../shared/teaching').CardEditBody) =>
        invoke<import('../shared/teaching').TeachingCard>(IpcChannel.teachingCardEdit, body),
    },
    gradeCard: (body: import('../shared/teaching').GradeCardBody) =>
      invoke<import('../shared/teaching').GradeCardResult>(IpcChannel.teachingGradeCard, body),
    gradeMiss: (body: import('../shared/teaching').GradeMissBody) =>
      invoke<import('../shared/teaching').MissItem>(IpcChannel.teachingGradeMiss, body),
    answerQuiz: (body: { lectureId: string; quizId: string; choice: number }) =>
      invoke<import('../shared/teaching').QuizAnswerResult>(IpcChannel.teachingAnswerQuiz, body),
    misses: (body: { limit?: number } = {}) =>
      invoke<import('../shared/teaching').MissList>(IpcChannel.teachingMisses, body),
    today: () => invoke<import('../shared/teaching').DayMarkView>(IpcChannel.teachingToday, {}),
    note: (body: { lectureId: string }) =>
      invoke<{ text: string }>(IpcChannel.teachingNote, body),
    reviewSummary: () => invoke<import('../shared/teaching').ReviewSummary>(IpcChannel.teachingReviewSummary, {}),
    exportCards: () => invoke<import('../shared/contract').ExportPayload>(IpcChannel.teachingExportCards, {}),
    exportMisses: () => invoke<import('../shared/contract').ExportPayload>(IpcChannel.teachingExportMisses, {}),
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
    create: (body: { requestId: string; documentVersionId: string; title?: string; subject?: string; courseId?: string | null }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyCreate, body),
    list: () => invoke<import('../shared/study').StudySessionList>(IpcChannel.studyList, {}),
    courses: () => invoke<import('../shared/study').StudyCourseTree>(IpcChannel.studyCourses, {}),
    courseCreate: (body: { name: string }) =>
      invoke<import('../shared/study').StudyCourseTree>(IpcChannel.studyCourseCreate, body),
    courseRename: (body: { courseId: string; name: string }) =>
      invoke<import('../shared/study').StudyCourseTree>(IpcChannel.studyCourseRename, body),
    courseDelete: (body: { courseId: string }) =>
      invoke<import('../shared/study').StudyCourseTree>(IpcChannel.studyCourseDelete, body),
    courseReorder: (body: { ids: string[] }) =>
      invoke<import('../shared/study').StudyCourseTree>(IpcChannel.studyCourseReorder, body),
    get: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyGet, body),
    send: (body: { sessionId: string; content: string; unitOrdinal?: number | null; mode?: import('../shared/study').StudyMode; skill?: import('../shared/study').StudySkill }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studySend, body),
    tool: (body: {
      sessionId: string
      tool: import('../shared/study').StudyToolKind
      unitOrdinal?: number | null
      query?: string
      answer?: string
      answers?: import('../shared/study').StudyQuizAnswer[]
    }) => invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyTool, body),
    usageAudit: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudyUsageAudit>(IpcChannel.studyUsageAudit, body),
    finish: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyFinish, body),
    check: (body: { sessionId: string; unitOrdinal: number; segmentIndex: number; answer: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyCheck, body),
    clearChat: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyClearChat, body),
    clearSummary: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionDetail>(IpcChannel.studyClearSummary, body),
    delete: (body: { sessionId: string }) =>
      invoke<import('../shared/study').StudySessionList>(IpcChannel.studyDelete, body),
    onProgress: (callback: (progress: import('../shared/study').StudyProgress) => void) => {
      const listener = (_event: IpcRendererEvent, payload: import('../shared/study').StudyProgress) => callback(payload)
      ipcRenderer.on(IpcChannel.studyProgress, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.studyProgress, listener)
      }
    },
  },
  teacher: {
    overview: () => invoke<import('../shared/teacher').TeacherOverview>(IpcChannel.teacherOverview, {}),
    savePersona: (body: import('../shared/teacher').TeacherPersonaInput) =>
      invoke<import('../shared/teacher').TeacherPersona>(IpcChannel.teacherPersonaSave, body),
    saveProfile: (body: import('../shared/teacher').LearnerProfileInput) =>
      invoke<import('../shared/teacher').LearnerProfile>(IpcChannel.teacherProfileSave, body),
    memories: () => invoke<{ items: import('../shared/teacher').TeacherMemory[] }>(IpcChannel.teacherMemoryList, {}),
    saveMemory: (body: import('../shared/teacher').TeacherMemoryInput) =>
      invoke<import('../shared/teacher').TeacherMemory>(IpcChannel.teacherMemorySave, body),
    deleteMemory: (body: { id: string }) =>
      invoke<{ deleted: boolean }>(IpcChannel.teacherMemoryDelete, body),
    reset: () => invoke<import('../shared/teacher').TeacherOverview>(IpcChannel.teacherReset, {}),
    notes: () => invoke<{ items: import('../shared/teacher').TeacherNote[] }>(IpcChannel.teacherNoteList, {}),
    note: (body: { sessionId: string }) =>
      invoke<import('../shared/teacher').TeacherNote | null>(IpcChannel.teacherNoteGet, body),
    saveNote: (body: { sessionId: string; summary: string; worked: string[]; stuck: string[]; next: string[] }) =>
      invoke<import('../shared/teacher').TeacherNote>(IpcChannel.teacherNoteSave, body),
    deleteNote: (body: { sessionId: string }) =>
      invoke<{ deleted: boolean }>(IpcChannel.teacherNoteDelete, body),
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
    saveText: (body: { fileName: string; content: string }) =>
      invoke<import('../shared/contract').SaveTextResult>(IpcChannel.appSaveText, body),
    notify: (body: { title: string; body: string }) =>
      invoke<{ shown: boolean }>(IpcChannel.appNotify, body),
    downloadUpdate: (body: { assetUrl: string; assetName: string; assetSize: number | null }) =>
      invoke<import('../shared/app').UpdateDownloadResult>(IpcChannel.appDownloadUpdate, body),
    openUpdate: (body: { filePath: string }) =>
      invoke<{ opened: boolean }>(IpcChannel.appOpenUpdate, body),
    onUpdateProgress: (callback: (progress: import('../shared/app').UpdateDownloadProgress) => void) => {
      const listener = (_event: IpcRendererEvent, payload: import('../shared/app').UpdateDownloadProgress) => callback(payload)
      ipcRenderer.on(IpcChannel.appUpdateProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannel.appUpdateProgress, listener)
    },
  },
}

contextBridge.exposeInMainWorld('desk', desk)

export type DeskApi = typeof desk
