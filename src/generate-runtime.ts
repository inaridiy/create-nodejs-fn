import path from "node:path";
import { writeFileIfChanged } from "./fs-utils";
import { makeProject, printSource } from "./project-utils";

export function generateRuntime(gdirAbs: string, runtimeFileName: string) {
  const genProject = makeProject();
  const filePath = path.join(gdirAbs, runtimeFileName);
  const sf = genProject.createSourceFile(filePath, "", { overwrite: true });
  sf.addStatements([
    "// AUTO-GENERATED (runtime marker)",
    "// Intentionally tiny. Used only as a marker in *.container.ts",
  ]);

  sf.addTypeAlias({
    isExported: true,
    name: "ContainerKey",
    type: `string | ((ctx: { args: any[] }) => string | Promise<string>)`,
  });

  sf.addTypeAlias({
    isExported: true,
    name: "ContainerKeyToken",
    type: `{ readonly __containerKeyBrand: true; containerKey: ContainerKey }`,
  });

  sf.addFunction({
    isExported: true,
    name: "nodejsFn",
    typeParameters: [{ name: "T", constraint: "(...args: any[]) => any" }],
    parameters: [
      { name: "fn", type: "T" },
      { name: "_opts?", type: "ContainerKeyToken" },
    ],
    returnType: "T",
    statements: "return fn;",
  });

  sf.addFunction({
    isExported: true,
    name: "containerKey",
    parameters: [{ name: "value", type: "ContainerKey" }],
    returnType: "ContainerKeyToken",
    statements: `return { __containerKeyBrand: true, containerKey: value } as const;`,
  });

  writeFileIfChanged(filePath, printSource(sf));
}
