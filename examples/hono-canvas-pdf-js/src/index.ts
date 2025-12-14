import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import z from "zod";
import { renderPdfPage } from "./pdf.container";

const app = new Hono();

app.get(
  "/renderPdf",
  sValidator("query", z.object({ url: z.url(), pageNum: z.string(), scale: z.string() })),
  async (c) => {
    const { url, pageNum, scale } = c.req.valid("query");
    const webpDataUrl = await renderPdfPage(url, Number(pageNum), Number(scale));
    return fetch(webpDataUrl);
  },
);

export { NodejsFnContainer } from "./__generated__/create-nodejs-fn.do";

export default {
  fetch: app.fetch,
};
