import { registerArchiveAgent } from './archiveAgent.js';
import { registerCancelRun } from './cancelRun.js';
import { registerDeleteAgent } from './deleteAgent.js';
import { registerDownloadArtifact } from './downloadArtifact.js';
import { registerGetAgent } from './getAgent.js';
import { registerGetRun } from './getRun.js';
import { registerGetRunEvents } from './getRunEvents.js';
import { registerGetUsage } from './getUsage.js';
import { registerLaunchAgent } from './launchAgent.js';
import { registerListAgents } from './listAgents.js';
import { registerListArtifacts } from './listArtifacts.js';
import { registerListModels } from './listModels.js';
import { registerListRepositories } from './listRepositories.js';
import { registerListRuns } from './listRuns.js';
import { registerSendFollowup } from './sendFollowup.js';
import { registerUnarchiveAgent } from './unarchiveAgent.js';
import { registerWaitForRun } from './waitForRun.js';
import { registerWhoami } from './whoami.js';
import type { RegisterToolArgs } from './shared.js';

/** Every tool this server exposes, in the order they are registered. */
export const TOOL_NAMES = [
  'launch_agent',
  'send_followup',
  'cancel_run',
  'archive_agent',
  'unarchive_agent',
  'delete_agent',
  'get_agent',
  'get_run',
  'get_run_events',
  'wait_for_run',
  'list_agents',
  'list_runs',
  'whoami',
  'list_models',
  'list_repositories',
  'get_usage',
  'list_artifacts',
  'download_artifact',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function registerAllTools(args: RegisterToolArgs): void {
  registerLaunchAgent(args);
  registerSendFollowup(args);
  registerCancelRun(args);
  registerArchiveAgent(args);
  registerUnarchiveAgent(args);
  registerDeleteAgent(args);
  registerGetAgent(args);
  registerGetRun(args);
  registerGetRunEvents(args);
  registerWaitForRun(args);
  registerListAgents(args);
  registerListRuns(args);
  registerWhoami(args);
  registerListModels(args);
  registerListRepositories(args);
  registerGetUsage(args);
  registerListArtifacts(args);
  registerDownloadArtifact(args);
}
