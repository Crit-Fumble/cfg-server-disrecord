/**
 * Which way does Discord deliver this application's interactions?
 *
 * ## Why the container has to ask
 *
 * Discord delivers interactions ONE of two ways, and the docs are absolute
 * that they are "mutually exclusive": over the GATEWAY, or by HTTP POST to the
 * application's configured **Interactions Endpoint URL**. Setting that URL
 * silently stops gateway delivery — for every interaction type, application
 * wide.
 *
 * The consent buttons are the container's whole consent surface in self-host,
 * and `ConsentManager` listens on the gateway. So against an application that
 * has an endpoint URL configured, every click lands somewhere else, the clicker
 * sees Discord's ephemeral "didn't respond in time", the audio gate never
 * opens, and the session records silence. Nothing appears in the container's
 * logs, because from its side nothing happened.
 *
 * That is the failure this module exists to name. The container already models
 * deployment MODE (`config.cfg != null`); interaction DELIVERY is a second,
 * independent, per-APPLICATION axis it could not previously observe.
 *
 * ## Warn, never refuse
 *
 * `assertOpenSurfaceBindIsSafe` refuses to boot because its failure has no
 * substitute. This one does: the control API and its dashboard grant consent
 * without Discord interactions at all. A self-hoster whose own bot legitimately
 * owns interactions and drives consent over the API must still be able to run.
 *
 * ## CFG-hosted is not a misconfiguration
 *
 * There the endpoint URL is CORRECT and belongs to core-server, which owns
 * `RecordingConsent`, authz and billing. One URL exists per application, the
 * platform application is shared by every user, and the worker is ephemeral and
 * unreachable from the internet — so the container could not own that surface
 * even if it wanted to. This check is therefore self-host only.
 */

import type { Logger } from '../logger.js'

export interface InteractionDelivery {
  /** `gateway` — clicks reach us. `http` — they go to `endpointUrl` instead. */
  route: 'gateway' | 'http' | 'unknown'
  /** The configured Interactions Endpoint URL, when there is one. */
  endpointUrl: string | null
}

/**
 * Ask Discord how this application is configured.
 *
 * Best-effort: a failure returns `unknown` rather than throwing, because not
 * knowing must never stop a recording. Verified empirically that
 * `GET /applications/@me` answers a BOT token and carries
 * `interactions_endpoint_url`.
 */
export async function fetchInteractionDelivery(
  botToken: string,
  logger: Logger,
): Promise<InteractionDelivery> {
  try {
    const res = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: { authorization: `Bot ${botToken}` },
    })
    if (!res.ok) {
      logger.debug?.({ status: res.status }, 'could not read application config')
      return { route: 'unknown', endpointUrl: null }
    }
    const app = (await res.json()) as { interactions_endpoint_url?: string | null }
    const endpointUrl = app.interactions_endpoint_url || null
    return { route: endpointUrl ? 'http' : 'gateway', endpointUrl }
  } catch (err) {
    logger.debug?.({ err }, 'could not read application config')
    return { route: 'unknown', endpointUrl: null }
  }
}

/**
 * Say plainly that the consent buttons are dead, and what to do instead.
 *
 * Deliberately long and deliberately loud. The alternative — the state this
 * replaces — is a recording of silence with nothing anywhere to explain it.
 */
export function warnIfButtonsCannotFire(delivery: InteractionDelivery, logger: Logger): void {
  if (delivery.route !== 'http' || !delivery.endpointUrl) return
  logger.warn(
    { interactionsEndpointUrl: delivery.endpointUrl },
    'CONSENT BUTTONS WILL NEVER FIRE. This Discord application has an Interactions ' +
      'Endpoint URL configured, so Discord POSTs every interaction there over HTTP and ' +
      'stops delivering them over the gateway — the two are mutually exclusive. Clicking ' +
      'a consent button will show "didn\'t respond in time", the audio gate will stay ' +
      'shut, and the session will record SILENCE. Fix: use a Discord application with NO ' +
      'Interactions Endpoint URL (a self-host bot should have none), then restart. Or ' +
      'grant consent from the dashboard / POST /v1/recordings/:id/consent, which needs no ' +
      'Discord interactions at all.',
  )
}
