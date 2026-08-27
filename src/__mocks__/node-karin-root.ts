import os from 'node:os'
import path from 'node:path'

export const basePath = path.join(os.tmpdir(), 'karin-plugin-shotium-test')
export const karinPathHtml = path.join(basePath, 'html')
