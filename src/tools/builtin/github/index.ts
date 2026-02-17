import type { Tool } from '../../types'
import { createGhBranchCreate } from './branch'
import { createGhCiStatus } from './ci'
import type { GitHubConfig } from './helpers'
import {
  createGhIssueComment,
  createGhIssueList,
  createGhIssueUpdate,
  createGhIssueView,
} from './issues'
import {
  createGhPrComment,
  createGhPrCreate,
  createGhPrList,
  createGhPrReview,
  createGhPrView,
} from './pr'
import { createGhReleaseList } from './release'

export type { GitHubConfig } from './helpers'

export function createGitHubTools(config: GitHubConfig): {
  ghPrListTool: Tool
  ghPrViewTool: Tool
  ghPrCreateTool: Tool
  ghPrReviewTool: Tool
  ghPrCommentTool: Tool
  ghIssueListTool: Tool
  ghIssueViewTool: Tool
  ghIssueCommentTool: Tool
  ghIssueUpdateTool: Tool
  ghCiStatusTool: Tool
  ghBranchCreateTool: Tool
  ghReleaseListTool: Tool
} {
  return {
    ghPrListTool: createGhPrList(config),
    ghPrViewTool: createGhPrView(config),
    ghPrCreateTool: createGhPrCreate(config),
    ghPrReviewTool: createGhPrReview(config),
    ghPrCommentTool: createGhPrComment(config),
    ghIssueListTool: createGhIssueList(config),
    ghIssueViewTool: createGhIssueView(config),
    ghIssueCommentTool: createGhIssueComment(config),
    ghIssueUpdateTool: createGhIssueUpdate(config),
    ghCiStatusTool: createGhCiStatus(config),
    ghBranchCreateTool: createGhBranchCreate(config),
    ghReleaseListTool: createGhReleaseList(config),
  }
}
