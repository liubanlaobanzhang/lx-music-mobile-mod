import { addTask, updateTask, removeTask, addHistory, setInitialized, setTasks, setHistory } from '@/store/download/action'
import { saveDownloadTasks, saveDownloadHistory, getDownloadTasks, getDownloadHistory } from '@/utils/data'
import { downloadEvent } from '@/event/downloadEvent'
import { generateFileName } from './filename'
import { getSaveDirectory, ensureDirectory } from './directory'
import { enqueueDownload, saveLyricFile, saveCoverFile, stopDownload } from './engine'
import { getMusicUrl as getOnlineMusicUrl, getLyricInfo as fetchOnlineLyricInfo, getPicUrl as getOnlinePicUrl } from '@/core/music/online'
import { unlink } from '@/utils/fs'
import { toast } from '@/utils/tools'
import settingState from '@/store/setting/state'
import { downloadState } from '@/store/download'

let isInited = false

const init = async(): Promise<void> => {
  if (isInited) return

  try {
    const tasks = await getDownloadTasks()
    const history = await getDownloadHistory()

    const completedTasks: LX.Download.ListItem[] = []
    const failedTasks: LX.Download.DownloadHistoryItem[] = []

    for (const task of tasks) {
      if (task.status === 'completed') {
        completedTasks.push(task)
      } else {
        failedTasks.push({
          id: task.id,
          musicInfo: task.metadata.musicInfo,
          quality: task.metadata.quality,
          ext: task.metadata.ext,
          fileName: task.metadata.fileName,
          filePath: task.metadata.filePath,
          status: 'failed',
          downloadedSize: task.downloaded,
          fileSize: task.total,
          addedTime: Date.now(),
          completedTime: null,
          errorMessage: task.statusText || '下载中断',
        })
      }
    }

    setTasks([])
    setHistory([...history, ...completedTasks.map(t => ({
      id: t.id,
      musicInfo: t.metadata.musicInfo,
      quality: t.metadata.quality,
      ext: t.metadata.ext,
      fileName: t.metadata.fileName,
      filePath: t.metadata.filePath,
      status: 'completed' as const,
      downloadedSize: t.downloaded,
      fileSize: t.total,
      addedTime: Date.now(),
      completedTime: Date.now(),
      errorMessage: null,
    })), ...failedTasks])

    await saveDownloadTasks([])
    await saveDownloadHistory([...history, ...completedTasks.map(t => ({
      id: t.id,
      musicInfo: t.metadata.musicInfo,
      quality: t.metadata.quality,
      ext: t.metadata.ext,
      fileName: t.metadata.fileName,
      filePath: t.metadata.filePath,
      status: 'completed' as const,
      downloadedSize: t.downloaded,
      fileSize: t.total,
      addedTime: Date.now(),
      completedTime: Date.now(),
      errorMessage: null,
    })), ...failedTasks])

    setInitialized(true)
    isInited = true
  } catch (err) {
    console.error('[download init] Init failed:', err)
  }
}

const isMusicInList = (musicInfo: LX.Music.MusicInfoOnline): boolean => {
  return downloadState.tasks.some(t => t.metadata.musicInfo.id === musicInfo.id)
    || downloadState.history.some(h => h.musicInfo.id === musicInfo.id)
}

/**
 * 真正执行一个下载任务:获取播放地址 → 入队下载
 * @param isRefreshUrl 是否强制刷新歌曲地址(重试时使用,旧地址通常已失效)
 */
async function runTask(taskId: string, isRefreshUrl = false): Promise<void> {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (!task) return

  const musicInfo = task.metadata.musicInfo

  try {
    await ensureDirectory(await getSaveDirectory())

    const url = await getOnlineMusicUrl({
      musicInfo,
      quality: task.metadata.quality,
      isRefresh: isRefreshUrl,
    })

    if (!url) {
      updateTask(taskId, {
        status: 'error',
        statusText: global.i18n.t('download_url_failed'),
      })
      await saveDownloadTasks([...downloadState.tasks])
      downloadEvent.downloadListUpdate()
      toast(global.i18n.t('download_url_failed'))
      return
    }

    updateTask(taskId, {
      status: 'run',
      statusText: '',
      metadata: { ...task.metadata, url },
    })
    await saveDownloadTasks([...downloadState.tasks])
    downloadEvent.downloadListUpdate()

    const updatedTask = downloadState.tasks.find(t => t.id === taskId)
    if (!updatedTask) return

    enqueueDownload(
      updatedTask,
      (progress) => {
        updateTask(taskId, {
          progress: progress.progress,
          speed: progress.speed,
          downloaded: progress.downloaded,
          total: progress.total,
          statusText: `Downloading... ${(progress.progress * 100).toFixed(1)}%`,
        })
      },
      async(completedTaskId, fileSize) => {
        updateTask(completedTaskId, {
          isComplate: true,
          status: 'completed',
          statusText: 'Completed',
          total: fileSize,
        })

        const completedTask = downloadState.tasks.find(t => t.id === completedTaskId)
        if (!completedTask) return

        // Save lyric
        try {
          const lyricInfo = await fetchOnlineLyricInfo({
            musicInfo: completedTask.metadata.musicInfo,
            isRefresh: false,
          })
          await saveLyricFile(lyricInfo, completedTask.metadata.filePath)
        } catch {
          // Ignore lyric errors
        }

        // Save cover
        try {
          const picUrl = await getOnlinePicUrl({
            musicInfo: completedTask.metadata.musicInfo,
            isRefresh: false,
          })
          if (picUrl) {
            await saveCoverFile(picUrl, completedTask.metadata.filePath)
          }
        } catch {
          // Ignore cover errors
        }

        const historyItem: LX.Download.DownloadHistoryItem = {
          id: completedTask.id,
          musicInfo: completedTask.metadata.musicInfo,
          quality: completedTask.metadata.quality,
          ext: completedTask.metadata.ext,
          fileName: completedTask.metadata.fileName,
          filePath: completedTask.metadata.filePath,
          status: 'completed',
          downloadedSize: completedTask.downloaded,
          fileSize: completedTask.total,
          addedTime: Date.now(),
          completedTime: Date.now(),
          errorMessage: null,
        }

        addHistory(historyItem)
        removeTask(completedTaskId)

        await saveDownloadTasks(downloadState.tasks.filter(t => t.id !== completedTaskId))
        await saveDownloadHistory([...downloadState.history])

        downloadEvent.downloadListUpdate()
        downloadEvent.downloadHistoryUpdate()
      },
      async(completedTaskId, error) => {
        updateTask(completedTaskId, {
          status: 'error',
          statusText: error,
        })
        await saveDownloadTasks([...downloadState.tasks])
        downloadEvent.downloadListUpdate()
        toast(global.i18n.t('download_failed') + ': ' + error)
      },
    )
  } catch (err: any) {
    console.error('[Download] Failed to run task:', err)
    updateTask(taskId, {
      status: 'error',
      statusText: err.message || global.i18n.t('download_failed'),
    })
    await saveDownloadTasks([...downloadState.tasks])
    downloadEvent.downloadListUpdate()
    toast(global.i18n.t('download_failed'))
  }
}

const addTaskWithDownload = async(musicInfo: LX.Music.MusicInfoOnline, quality?: LX.Quality): Promise<boolean> => {
  if (isMusicInList(musicInfo)) {
    toast(global.i18n.t('download_exists_tip'))
    return false
  }

  let downloadQuality: LX.Quality = '128k'
  try {
    if (settingState && settingState.setting['download.quality']) {
      downloadQuality = settingState.setting['download.quality'] as LX.Quality
    }
    if (quality) {
      downloadQuality = quality
    }
  } catch {
    // Use default 128k
  }

  try {
    const saveDir = await getSaveDirectory()

    const ext = downloadQuality === 'flac' || downloadQuality === 'flac24bit' ? 'flac' : 'mp3'
    const fileName = generateFileName(musicInfo, downloadQuality, ext)
    const filePath = `${saveDir}/${fileName}`

    const taskId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const task: LX.Download.ListItem = {
      id: taskId,
      isComplate: false,
      status: 'waiting',
      statusText: global.i18n.t('download_waiting_for_url'),
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      metadata: {
        musicInfo,
        url: null,
        quality: downloadQuality,
        ext: ext as LX.Download.FileExt,
        fileName,
        filePath,
      },
    }

    addTask(task)

    await saveDownloadTasks([...downloadState.tasks])

    downloadEvent.downloadListUpdate()

    toast(global.i18n.t('download_add_tip'))

    void runTask(taskId)

    return true
  } catch (err: any) {
    console.error('[addTaskWithDownload] ERROR:', err)
    toast(global.i18n.t('download_failed') + ': ' + (err.message || 'unknown'))
    return false
  }
}

const deleteTask = async(taskId: string): Promise<void> => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (task) {
    // 先停止原生下载(排队中的任务会从队列移除),再删掉半成品文件
    stopDownload(taskId)
    removeTask(taskId)
    await saveDownloadTasks([...downloadState.tasks])

    try {
      await unlink(task.metadata.filePath)
    } catch {
      // 文件可能还没创建
    }

    downloadEvent.downloadListUpdate()
    return
  }

  const historyItem = downloadState.history.find(h => h.id === taskId)
  if (historyItem && historyItem.filePath) {
    try {
      await unlink(historyItem.filePath)
    } catch {
      // File may not exist
    }
  }
  if (historyItem) {
    const newHistory = downloadState.history.filter(h => h.id !== taskId)
    setHistory(newHistory)
    await saveDownloadHistory(newHistory)
    downloadEvent.downloadHistoryUpdate()
  }
}

/**
 * 重试下载任务
 * - 当前任务列表里失败/已暂停的任务:原地重置并重新获取地址下载
 * - 历史记录里失败的任务:移出历史,作为新任务重新下载
 */
const retryTask = async(taskId: string): Promise<boolean> => {
  const task = downloadState.tasks.find(t => t.id === taskId)
  if (task) {
    if (task.status !== 'error' && task.status !== 'pause') return false

    // 清掉可能残留的半成品文件,避免续写出错
    try {
      await unlink(task.metadata.filePath)
    } catch {
      // 文件可能不存在
    }

    updateTask(taskId, {
      isComplate: false,
      status: 'waiting',
      statusText: global.i18n.t('download_waiting_for_url'),
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      metadata: { ...task.metadata, url: null },
    })
    await saveDownloadTasks([...downloadState.tasks])
    downloadEvent.downloadListUpdate()

    toast(global.i18n.t('download_retry_started'))

    void runTask(taskId, true)
    return true
  }

  const historyItem = downloadState.history.find(h => h.id === taskId)
  if (!historyItem) return false

  const newHistory = downloadState.history.filter(h => h.id !== taskId)
  setHistory(newHistory)
  await saveDownloadHistory(newHistory)

  return addTaskWithDownload(historyItem.musicInfo, historyItem.quality)
}

const clearAllHistory = async(): Promise<void> => {
  // 正在进行的任务不受影响,历史记录里的文件保留
  setHistory([])
  await saveDownloadHistory([])
  downloadEvent.downloadHistoryUpdate()
}

const getTasks = (): LX.Download.ListItem[] => {
  return [...downloadState.tasks]
}

const getHistory = (): LX.Download.DownloadHistoryItem[] => {
  return [...downloadState.history]
}

const getDownloadingCount = (): number => {
  return downloadState.tasks.filter(t => t.status === 'run').length
}

export const downloadManager = {
  init,
  addTask: addTaskWithDownload,
  isMusicInList,
  deleteTask,
  retryTask,
  clearHistory: clearAllHistory,
  getTasks,
  getHistory,
  getDownloadingCount,
}

// 兼容旧 API:addDownload 映射到 downloadManager.addTask
export const addDownload = (musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality = '128k'): Promise<boolean> => {
  return downloadManager.addTask(musicInfo, quality)
}

export const DOWNLOAD_QUALITIES = [
  { id: '128k', label: '128k - 标准品质' },
  { id: '192k', label: '192k - 高品质' },
  { id: '320k', label: '320k - 超高品质' },
  { id: 'ape', label: 'APE - 无损' },
  { id: 'flac', label: 'FLAC - 无损' },
  { id: 'wav', label: 'WAV - 无损' },
] as const
