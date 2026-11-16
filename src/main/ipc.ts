import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { BrowserWindow } from 'electron'
import type { AiService } from '../ai/service'
import { ArgumentError } from '../domain/validation'
import { DocumentService } from '../documents/service'
import type { ImageService } from '../images/service'
import type { TeachingService } from '../teaching/service'
import type { StudyService } from '../study/service'
import type { AppInfoService } from '../app/info'
import { fail } from '../shared/contract'
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
  bind(IpcChannel.teachingGradeCard, (_event, body) => teaching.gradeCard(body))
  bind(IpcChannel.teachingAnswerQuiz, (_event, body) => teaching.answerQuiz(body))
  bind(IpcChannel.teachingMisses, (_event, body) => teaching.misses(body))
  bind(IpcChannel.teachingToday, () => teaching.today())
  bind(IpcChannel.teachingNote, (_event, body) => teaching.note(body))
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
  bind(IpcChannel.studyGet, (_event, body) => study.get(body))
  bind(IpcChannel.studySend, (_event, body) => study.send(body))
  bind(IpcChannel.studyFinish, (_event, body) => study.finish(body))
  bind(IpcChannel.studyCheck, (_event, body) => study.check(body))
  bind(IpcChannel.studyClearChat, (_event, body) => study.clearChat(body))
  bind(IpcChannel.studyClearSummary, (_event, body) => study.clearSummary(body))
  bind(IpcChannel.studyDelete, (_event, body) => study.deleteCourse(body))
  bind(IpcChannel.appInfo, () => appInfo.info())
  bind(IpcChannel.appCheckUpdate, () => appInfo.checkUpdate())
  return [...IPC_INVOKE_CHANNELS]
}
