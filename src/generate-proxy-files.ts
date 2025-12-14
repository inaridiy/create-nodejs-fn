import path from "node:path";
import { VariableDeclarationKind } from "ts-morph";
import { writeFileIfChanged } from "./fs-utils";
import { proxyFilePath } from "./path-utils";
import { makeProject, printSource } from "./project-utils";
import type { DiscoveredModule } from "./types";

export type ProxyFileGenOptions = {
  gdirAbs: string;
  mods: DiscoveredModule[];
  root: string;
  generatedContextFileName: string;
  generatedClientFileName: string;
};

export function generateProxyFiles(opts: ProxyFileGenOptions) {
  const { gdirAbs, mods, root, generatedClientFileName, generatedContextFileName } = opts;
  const genProject = makeProject();

  for (const mod of mods) {
    const proxyPath = proxyFilePath(gdirAbs, mod.fileAbs);
    const sf = genProject.createSourceFile(proxyPath, "", { overwrite: true });
    sf.addStatements([`// AUTO-GENERATED. DO NOT EDIT.`, `// Proxy for: ${mod.fileRelFromRoot}`]);

    const relToGen = path.relative(path.dirname(proxyPath), gdirAbs).replace(/\\/g, "/");
    const genBase = relToGen.startsWith(".") ? relToGen : `./${relToGen}`;

    sf.addImportDeclaration({
      moduleSpecifier: `${genBase}/${generatedClientFileName.replace(/\.ts$/, "")}`,
      namedImports: ["containers"],
    });
    sf.addImportDeclaration({
      moduleSpecifier: `${genBase}/${generatedContextFileName.replace(/\.ts$/, "")}`,
      namedImports: ["__resolveContainerKey"],
    });

    sf.addTypeAlias({
      name: "__Key",
      type: `string | ((ctx: { args: any[] }) => string | Promise<string>)`,
    });

    for (const ex of mod.exports) {
      const importRel = path
        .relative(path.dirname(proxyPath), path.join(root, mod.fileRelFromRoot))
        .replace(/\\/g, "/")
        .replace(/\.tsx?$/, "");
      const tName = `__T_${ex.name}`;

      sf.addTypeAlias({
        name: tName,
        type: `typeof import(${JSON.stringify(importRel)}).${ex.name}`,
      });

      const keyExpr = ex.containerKeyExpr ?? "undefined";

      sf.addVariableStatement({
        declarationKind: VariableDeclarationKind.Const,
        isExported: true,
        declarations: [
          {
            name: ex.name,
            type: tName,
            initializer: `
((...args: any[]) => {
  const ctx = { args };
  const localKey = (${keyExpr}) as __Key | undefined;
  const keyP = __resolveContainerKey(${JSON.stringify(mod.namespace)}, ${JSON.stringify(
    ex.name,
  )}, ctx, localKey ?? "default");

  return Promise.resolve(keyP).then((key) =>
    (containers({ containerKey: key }) as any).${mod.namespace}.${ex.name}(...args),
  );
}) as any
            `.trim(),
          },
        ],
      });
    }

    writeFileIfChanged(proxyPath, printSource(sf));
  }
}
