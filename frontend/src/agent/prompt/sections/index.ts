import type { PromptSectionDef } from '../types'
import { workCognition } from './workCognition'
import { whenToCallTools, callableTools } from './toolBasics'
import { discovery } from './discovery'
import { sql } from './sql'
import { mcp, skill, skillCraft, workflowCraft } from './plugins'
import { decisionTree, platformComposition } from './selection'
import { feedbackNature } from './feedbackNature'
import { systemSignals } from './systemSignals'
import { memory } from './memory'
import { collaborationModes } from './collaborationModes'
import { answerStyle } from './answerStyle'
import { executionThinking } from './executionThinking'
import { longWaits } from './longWaits'
import {
  serialParallel,
  preCallCheck,
  postCallFeedback,
  stopCondition,
  errorSop,
  attitude,
} from './loopRules'

/**
 * 主提示词「工具使用原则（元认知）」的小节清单——顺序即编号。
 * 新增主题：在 sections/ 下新建 def，然后在本数组加一行；交叉引用写 {ref:id}。
 * 缓存纪律：static 节必须全部排在 session 节之前（当前全部为 static）。
 */
export const MAIN_SECTIONS: PromptSectionDef[] = [
  workCognition,
  whenToCallTools,
  callableTools,
  discovery,
  sql,
  mcp,
  skill,
  skillCraft,
  workflowCraft,
  decisionTree,
  platformComposition,
  feedbackNature,
  executionThinking,
  systemSignals,
  memory,
  collaborationModes,
  answerStyle,
  serialParallel,
  preCallCheck,
  postCallFeedback,
  stopCondition,
  errorSop,
  attitude,
  longWaits,
]
