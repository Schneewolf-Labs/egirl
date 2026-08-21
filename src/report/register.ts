import type { RuntimeConfig } from '../config'
import type { ToolExecutor } from '../tools'
import { log } from '../util/logger'
import type { ReplyBroker } from './broker'
import { createReportTool, parseReportTarget } from './tool'

/**
 * Register the report tool from [report] config, if present. Called by each entry point
 * after its channels exist — what "connected" means differs per process (serve has outbound
 * chat channels; api has only peers), and the tool degrades honestly for the rest.
 */
export function registerReportTool(
  config: RuntimeConfig,
  toolExecutor: ToolExecutor,
  outbound: Map<string, { send(target: string, message: string): Promise<void> }>,
  broker?: ReplyBroker,
): void {
  if (!config.report) return
  const target = parseReportTarget(config.report.to)
  if (!target) {
    log.warn(
      'report',
      `[report] to = "${config.report.to}" is not a valid target ("peer:<name>" or "<channel>:<target>") — report tool NOT registered`,
    )
    return
  }
  if (target.kind === 'peer' && !config.peers?.some((p) => p.name === target.channel)) {
    log.warn(
      'report',
      `[report] to = "${config.report.to}" names a peer that is not in [[peers]] — report tool NOT registered`,
    )
    return
  }
  toolExecutor.register(
    createReportTool({
      to: target,
      toRaw: config.report.to,
      selfName: config.source.instance ?? 'egirl',
      peers: config.peers ?? [],
      outbound,
      broker,
      askTimeoutMs: config.report.askTimeoutMs,
    }),
  )
  log.info('report', `report tool registered → ${config.report.to}`)
}
