/**
 * 本地拖拽演示：直接渲染真实的 A2uiCanvasPanel，用一组多节点 canvas 页面
 * 验证弯曲连线的拖拽交互。仅供本地手工验证，不属于包源码或测试，不参与
 * 仓库门禁。
 */
import { createRoot } from 'react-dom/client'
import { A2uiCanvasPanel, type A2uiCanvasPanelProps } from '@deepseek-ai/dsh-client-ui-a2ui-render/src/A2uiCanvasPanel.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-a2ui-render/src/locales.ts'
import type { A2uiCanvasPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'

// 多节点 mock 页面：start→deploy 的「直通」直线恰好穿过 build 节点，适合演示把线拖开。
const page: A2uiCanvasPage = {
  kind: 'canvas',
  title: '发布流程',
  description: '把每条连线拖到节点外侧，避免线段盖住流程节点。',
  nodes: [
    { id: 'start', label: '开始', role: 'start', position: { x: 0, y: 160 } },
    { id: 'review', label: '代码评审', position: { x: 220, y: 40 } },
    { id: 'build', label: '构建镜像', detail: 'Linux arm64', position: { x: 220, y: 160 } },
    { id: 'qa', label: '测试验收', position: { x: 220, y: 300 } },
    { id: 'deploy', label: '发布上线', position: { x: 460, y: 160 } },
    { id: 'end', label: '完成', role: 'end', position: { x: 700, y: 160 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'review', label: '提审' },
    { id: 'e2', source: 'start', target: 'build', label: '直接构建' },
    { id: 'e3', source: 'start', target: 'deploy', label: '直通' },
    { id: 'e4', source: 'review', target: 'deploy' },
    { id: 'e5', source: 'build', target: 'qa', label: '通过' },
    { id: 'e6', source: 'qa', target: 'deploy' },
    { id: 'e7', source: 'build', target: 'deploy' },
    { id: 'e8', source: 'deploy', target: 'end', label: '上线' },
  ],
}

// 最小化翻译器：取 zh 文案，缺失时回退到 key 本身。
const t = (key: string, params?: Record<string, string>): string => {
  const template = zh[key as keyof typeof zh] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}

const props: A2uiCanvasPanelProps = {
  page,
  surfaceId: 'demo-1',
  t: t as never,
  busy: false,
  onSubmit: payload => console.log('[a2ui demo] submit:', payload),
  onAction: (action, values) => console.log('[a2ui demo] action:', action.id, values),
}

const root = createRoot(document.getElementById('app') as HTMLElement)
root.render(<A2uiCanvasPanel {...props} />)
