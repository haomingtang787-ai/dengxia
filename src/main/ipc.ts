import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, Notification, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AiService } from '../ai/service'
import { ArgumentError } from '../domain/validation'
import { DocumentService } from '../documents/service'
import type { ImageService } from '../images/service'
import type { TeachingService } from '../teaching/service'
import type { StudyService } from '../study/service'
import type { TeacherService } from '../teaching/teacherService'
import type { AppInfoService } from '../app/info'
import { ok, fail, type Result, type SaveTextResult } from '../shared/contract'
import { IpcChannel, IPC_INVOKE_CHANNELS, type IpcInvokeChannel } from '../shared/ipc'
import { randomUUID } from 'node:crypto'

export function windowIdFrom(event: IpcMainInvokeEvent): string {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new ArgumentError('没有可用的窗口。')
  return String(win.id)
}

export function registerIpc(
  ipc: IpcMain,
  service: DocumentService,
  teaching: TeachingService,
  ai: AiService,
  images: ImageService,
  study: StudyService,
  teacher: TeacherService,
  appInfo: AppInfoService,
): IpcInvokeChannel[] {
  const bind = (channel: IpcInvokeChannel, fn: (event: IpcMainInvokeEvent, body: unknown) => Promise<unknown> | unknown) => {
    ipc.handle(channel, async (event, body) => {
      try {
        return await fn(event, body)
      } catch (error) {
        console.error(channel, error)
        const message = error instanceof ArgumentError ? error.message : '本机处理出现未预期的错误。'
        const code = error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR'
        return fail(randomUUID(), code, message)
      }
    })
  }
  bind(IpcChannel.documentsPick, (event) => service.pick(windowIdFrom(event)))
  bind(IpcChannel.documentsImport, (event, body) => service.import(windowIdFrom(event), body))
  bind(IpcChannel.documentsList, (_event, body) => service.list(body))
  bind(IpcChannel.documentsGet, (_event, body) => service.get(body))
  bind(IpcChannel.documentsPages, (_event, body) => service.pages(body))
  bind(IpcChannel.documentsBlocks, (_event, body) => service.blocks(body))
  bind(IpcChannel.documentsOpenSource, (event, body) => service.openSource(windowIdFrom(event), body))
  bind(IpcChannel.documentsDelete, (_event, body) => service.delete(body))
  bind(IpcChannel.documentsSearch, (_event, body) => service.search(body))
  bind(IpcChannel.documentsHighlights, (_event, body) => service.highlights(body))
  bind(IpcChannel.documentsHighlightCreate, (_event, body) => service.createHighlight(body))
  bind(IpcChannel.documentsHighlightDelete, (_event, body) => service.deleteHighlight(body))
  bind(IpcChannel.documentsHighlightCleanup, (_event, body) => service.cleanupHighlights(body))
  bind(IpcChannel.documentsRename, (_event, body) => service.rename(body))
  bind(IpcChannel.documentsPin, (_event, body) => service.pin(body))
  bind(IpcChannel.reviewSettingsGet, () => service.reviewSettings())
  bind(IpcChannel.reviewSettingsSave, (_event, body) => service.saveReviewSettings(body))
  bind(IpcChannel.dataStorage, () => service.storage())
  bind(IpcChannel.dataStats, () => service.stats())
  bind(IpcChannel.dataBackup, (event) => service.backup(windowIdFrom(event)))
  bind(IpcChannel.dataBackupPickDir, (event) => service.pickBackupDirectory(windowIdFrom(event)))
  bind(IpcChannel.dataAutoBackup, () => service.autoBackup())
  bind(IpcChannel.dataRestoreInspect, (event) => service.inspectRestore(windowIdFrom(event)))
  bind(IpcChannel.dataRestoreApply, (_event, body) => service.applyRestore(body))
  bind(IpcChannel.dataSettingsGet, () => service.appSettings())
  bind(IpcChannel.dataSettingsSave, (_event, body) => service.saveAppSettings(body))
  bind(IpcChannel.jobsGet, (_event, body) => service.job(body))
  bind(IpcChannel.jobsCancel, (_event, body) => service.cancel(body))
  bind(IpcChannel.jobsRetry, (_event, body) => service.retry(body))
  bind(IpcChannel.prerequisitesGet, () => service.prerequisites())
  bind(IpcChannel.prerequisitesPickLibreOffice, (event) => service.pickLibreOffice(windowIdFrom(event)))
  bind(IpcChannel.prerequisitesRecheck, () => service.recheckLibreOffice())
  bind(IpcChannel.teachingHabitsGet, () => teaching.habits())
  bind(IpcChannel.teachingHabitsSave, (_event, body) => teaching.saveHabits(body))
  bind(IpcChannel.teachingLecturesCreate, (_event, body) => teaching.create(body))
  bind(IpcChannel.teachingLecturesList, () => teaching.list())
  bind(IpcChannel.teachingLecturesGet, (_event, body) => teaching.get(body))
  bind(IpcChannel.teachingMarkKnown, (_event, body) => teaching.markKnown(body))
  bind(IpcChannel.teachingSetCursor, (_event, body) => teaching.setCursor(body))
  bind(IpcChannel.teachingDueCards, () => teaching.dueCards())
  bind(IpcChannel.teachingCardsList, () => teaching.cardsList())
  bind(IpcChannel.teachingCardCreate, (_event, body) => teaching.cardCreate(body))
  bind(IpcChannel.teachingCardEdit, (_event, body) => teaching.cardEdit(body))
  bind(IpcChannel.teachingGradeCard, (_event, body) => teaching.gradeCard(body))
  bind(IpcChannel.teachingGradeMiss, (_event, body) => teaching.gradeMiss(body))
  bind(IpcChannel.teachingAnswerQuiz, (_event, body) => teaching.answerQuiz(body))
  bind(IpcChannel.teachingMisses, (_event, body) => teaching.misses(body))
  bind(IpcChannel.teachingToday, () => teaching.today())
  bind(IpcChannel.teachingNote, (_event, body) => teaching.note(body))
  bind(IpcChannel.teachingReviewSummary, () => teaching.reviewSummary())
  bind(IpcChannel.teachingExportCards, () => teaching.exportCards())
  bind(IpcChannel.teachingExportMisses, () => teaching.exportMisses())
  bind(IpcChannel.aiStatus, () => ai.status())
  bind(IpcChannel.aiSaveConfig, (_event, body) => ai.saveConfig(body))
  bind(IpcChannel.aiTest, () => ai.testConfig())
  bind(IpcChannel.aiMakeLecture, (_event, body) => ai.makeLecture(body))
  bind(IpcChannel.aiModels, (_event, body) => ai.models(body))
  bind(IpcChannel.imagesReadings, (_event, body) => images.readings(body))
  bind(IpcChannel.imagesOcr, (_event, body) => images.ocr(body))
  bind(IpcChannel.imagesVision, (_event, body) => images.vision(body))
  bind(IpcChannel.imagesAuto, (_event, body) => images.auto(body))
  bind(IpcChannel.researchList, (_event, body) => images.researchList(body))
  bind(IpcChannel.researchVerify, (_event, body) => images.researchVerify(body))
  bind(IpcChannel.studyCreate, (_event, body) => study.create(body))
  bind(IpcChannel.studyList, () => study.list())
  bind(IpcChannel.studyCourses, () => study.courses())
  bind(IpcChannel.studyCourseCreate, (_event, body) => study.createCourse(body))
  bind(IpcChannel.studyCourseRename, (_event, body) => study.renameCourse(body))
  bind(IpcChannel.studyCourseDelete, (_event, body) => study.deleteCourse(body))
  bind(IpcChannel.studyCourseReorder, (_event, body) => study.reorderCourses(body))
  bind(IpcChannel.studyGet, (_event, body) => study.get(body))
  bind(IpcChannel.studySend, (_event, body) => study.send(body))
  bind(IpcChannel.studyTool, (_event, body) => study.tool(body))
  bind(IpcChannel.studyUsageAudit, (_event, body) => study.usageAudit(body))
  bind(IpcChannel.studyFinish, (_event, body) => study.finish(body))
  bind(IpcChannel.studyCheck, (_event, body) => study.check(body))
  bind(IpcChannel.studyClearChat, (_event, body) => study.clearChat(body))
  bind(IpcChannel.studyClearSummary, (_event, body) => study.clearSummary(body))
  bind(IpcChannel.studyDelete, (_event, body) => study.deleteSession(body))
  bind(IpcChannel.teacherOverview, () => teacher.overview())
  bind(IpcChannel.teacherPersonaSave, (_event, body) => teacher.savePersona(body))
  bind(IpcChannel.teacherProfileSave, (_event, body) => teacher.saveProfile(body))
  bind(IpcChannel.teacherMemoryList, () => teacher.memoryList())
  bind(IpcChannel.teacherMemorySave, (_event, body) => teacher.memorySave(body))
  bind(IpcChannel.teacherMemoryDelete, (_event, body) => teacher.memoryDelete(body))
  bind(IpcChannel.teacherReset, () => teacher.reset())
  bind(IpcChannel.teacherNoteList, () => teacher.noteList())
  bind(IpcChannel.teacherNoteGet, (_event, body) => teacher.noteGet(body))
  bind(IpcChannel.teacherNoteSave, (_event, body) => teacher.noteSave(body))
  bind(IpcChannel.teacherNoteDelete, (_event, body) => teacher.noteDelete(body))
  bind(IpcChannel.appInfo, () => appInfo.info())
  bind(IpcChannel.appCheckUpdate, () => appInfo.checkUpdate())
  bind(IpcChannel.appSaveText, (event, body) => saveText(event, body))
  bind(IpcChannel.appNotify, (_event, body) => notify(body))
  bind(IpcChannel.appDownloadUpdate, (event, body) =>
    appInfo.downloadUpdate(body, (channel, payload) => event.sender.send(channel, payload)))
  bind(IpcChannel.appOpenUpdate, (_event, body) => appInfo.openUpdate(body))
  return [...IPC_INVOKE_CHANNELS]
}

async function saveText(event: IpcMainInvokeEvent, body: unknown): Promise<Result<SaveTextResult>> {
  const requestId = randomUUID()
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const fileName = typeof raw.fileName === 'string' ? path.basename(raw.fileName).slice(0, 80) : ''
  const content = typeof raw.content === 'string' ? raw.content : ''
  if (!fileName || !content) return fail(requestId, 'INVALID_ARGUMENT', '没有可保存的内容。')
  if (content.length > 10_000_000) return fail(requestId, 'LIMIT_EXCEEDED', '导出内容太大了。')
  const extension = path.extname(fileName).toLowerCase()
  const filters = extension === '.md'
    ? [{ name: 'Markdown', extensions: ['md'] }]
    : extension === '.txt'
      ? [{ name: '文本', extensions: ['txt'] }]
      : undefined
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = parent
    ? await dialog.showSaveDialog(parent, { defaultPath: fileName, filters })
    : await dialog.showSaveDialog({ defaultPath: fileName, filters })
  if (result.canceled || !result.filePath) return ok<SaveTextResult>(requestId, { saved: false, path: null })
  await fs.promises.writeFile(result.filePath, content, 'utf8')
  return ok<SaveTextResult>(requestId, { saved: true, path: result.filePath })
}

function notify(body: unknown): Result<{ shown: boolean }> {
  const requestId = randomUUID()
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 80) : ''
  const text = typeof raw.body === 'string' ? raw.body.trim().slice(0, 500) : ''
  if (!title || !text) return fail(requestId, 'INVALID_ARGUMENT', '通知内容为空。')
  if (!Notification.isSupported()) return ok(requestId, { shown: false })
  new Notification({ title, body: text }).show()
  return ok(requestId, { shown: true })
}
