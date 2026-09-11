export interface MesSessionStartupState {
  isOnline: boolean
  websiteMode: boolean
  isLoggedIn: boolean
  isMesLoggedIn: boolean
}

/**
 * Decide whether the startup path must validate the persisted MES session.
 * Local MESCLI users do not have a remote session and should not be replaced
 * by a failed remote check; a persisted MES identity must be checked because
 * its token can expire while the UI still shows the cached user.
 */
export function shouldValidateMesSessionOnStartup(state: MesSessionStartupState): boolean {
  if (state.isOnline || state.websiteMode) return false
  return state.isMesLoggedIn || !state.isLoggedIn
}
