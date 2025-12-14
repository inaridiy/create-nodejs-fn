import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import {createNodejsFnPlugin} from "../../src"

export default defineConfig({
  plugins: [cloudflare(), createNodejsFnPlugin()]
})
