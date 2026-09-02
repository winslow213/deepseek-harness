/**
 * 独立演示的 Vite 配置：把 react/react-dom 钉到 apps/web 依赖的同一个 18.x
 * store 副本，避免双 React 导致 hooks 失效。纯对象导出、不依赖从配置目录解析
 * vite 包，因此可被仓库根目录的 `node_modules/.bin/vite` 直接加载。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const webRequire = createRequire(fileURLToPath(new URL('../../../../apps/web/package.json', import.meta.url)))
const reactPath = webRequire.resolve('react/package.json').replace(/\/package\.json$/, '')
const reactDomPath = webRequire.resolve('react-dom/package.json').replace(/\/package\.json$/, '')

export default {
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactPath },
      { find: /^react\/jsx-runtime$/, replacement: `${reactPath}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${reactPath}/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: reactDomPath },
      { find: /^react-dom\/client$/, replacement: `${reactDomPath}/client.js` },
    ],
  },
}
