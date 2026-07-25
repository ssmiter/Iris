import { useState, useRef, useCallback } from 'react'
import { voiceApi } from '@/api/client'

interface UseVoiceRecorderReturn {
  isRecording: boolean
  recordingTime: number
  startRecording: () => Promise<void>
  stopRecording: () => Promise<string | null>
  error: string | null
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startRecording = useCallback(async () => {
    setError(null)
    audioChunksRef.current = []

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4',
      })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = () => {
        // 停止所有轨道
        stream.getTracks().forEach((track) => track.stop())
      }

      mediaRecorder.onerror = () => {
        setError('录音出错')
        setIsRecording(false)
      }

      mediaRecorder.start(100) // 每 100ms 收集一次数据
      mediaRecorderRef.current = mediaRecorder
      setIsRecording(true)
      setRecordingTime(0)

      // 计时器
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1)
      }, 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法访问麦克风')
      setIsRecording(false)
    }
  }, [])

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!mediaRecorderRef.current || !isRecording) return null

    // 停止计时器
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current!

      recorder.onstop = async () => {
        // 停止所有轨道
        const stream = recorder.stream
        stream.getTracks().forEach((track) => track.stop())

        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType,
        })

        if (audioBlob.size === 0) {
          setError('录音为空')
          setIsRecording(false)
          resolve(null)
          return
        }

        try {
          const response = await voiceApi.recognize(audioBlob)
          setIsRecording(false)
          setRecordingTime(0)
          resolve(response.text)
        } catch (err) {
          setError(err instanceof Error ? err.message : '语音识别失败')
          setIsRecording(false)
          setRecordingTime(0)
          resolve(null)
        }
      }

      recorder.stop()
    })
  }, [isRecording])

  return {
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    error,
  }
}
