export const LIVE_TRACK_COMMAND_EVENT = 'evren-live-track-command'
export const LIVE_TRACK_STATUS_EVENT = 'evren-live-track-status'

export type LiveTrackPoint = {
  id?: string
  lat: number
  lng: number
  accuracy?: number
  altitude?: number | null
  speed?: number | null
  heading?: number | null
  timestamp?: number
}

export type LiveTrackCommand =
  | 'start'
  | 'stop'
  | 'clear'
  | 'status'
  | { type: 'segments'; segmentBreaks: number[] }
  | { type: 'load'; points: LiveTrackPoint[]; segmentBreaks: number[]; rejectedCount?: number }

export type LiveTrackStatus = {
  tracking: boolean
  points: LiveTrackPoint[]
  segmentBreaks: number[]
  rejectedCount: number
}

export function sendLiveTrackCommand(command: LiveTrackCommand) {
  window.dispatchEvent(new CustomEvent<LiveTrackCommand>(LIVE_TRACK_COMMAND_EVENT, { detail: command }))
}

export function sendLiveTrackStatus(status: LiveTrackStatus) {
  window.dispatchEvent(new CustomEvent<LiveTrackStatus>(LIVE_TRACK_STATUS_EVENT, { detail: status }))
}
