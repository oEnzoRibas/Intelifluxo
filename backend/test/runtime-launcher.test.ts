import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const cmd = readFileSync(join(root, "start-intelifluxo.cmd"), "utf8");
const ps = readFileSync(join(root, "start-intelifluxo.ps1"), "utf8");

describe("supervisor launcher boundary", () => {
  it("keeps the cmd launcher fixed and clears preload options before node", () => {
    expect(cmd).not.toMatch(/%(?:\*|[1-9])/);
    expect(cmd).toContain("start-intelifluxo.ps1");
    expect(cmd.indexOf('set "NODE_OPTIONS="')).toBeLessThan(
      cmd.indexOf("where node"),
    );
    expect(ps.indexOf("Remove-Item Env:NODE_OPTIONS")).toBeLessThan(
      ps.indexOf("Get-Command node"),
    );
    expect(ps).not.toMatch(/Invoke-Expression|@args/i);
    const pkg = JSON.parse(
      readFileSync(join(root, "backend/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.supervisor).toBe("..\\start-intelifluxo.cmd");
  });

  it.skipIf(process.platform !== "win32")(
    "runs only fixed paths, maps switches, and removes NODE_OPTIONS",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "launcher test "));
      try {
        for (const file of ["start-intelifluxo.cmd", "start-intelifluxo.ps1"])
          copyFileSync(join(root, file), join(dir, file));
        for (const folder of [
          "backend/src",
          "backend/node_modules/tsx",
          "frontend/node_modules/vite/bin",
        ])
          mkdirSync(join(dir, folder), { recursive: true });
        writeFileSync(
          join(dir, "backend/node_modules/tsx/package.json"),
          JSON.stringify({
            name: "tsx",
            type: "module",
            exports: "./index.js",
          }),
        );
        writeFileSync(join(dir, "backend/node_modules/tsx/index.js"), "");
        writeFileSync(join(dir, "frontend/node_modules/vite/bin/vite.js"), "");
        const record = join(dir, "record.json"),
          marker = join(dir, "marker");
        writeFileSync(
          join(dir, "backend/src/runtime-supervisor-main.ts"),
          `require('node:fs').writeFileSync(process.env.RECORD, JSON.stringify({args: process.argv.slice(2), options: process.env.NODE_OPTIONS || null, cwd: process.cwd()}));`,
        );
        const preload = join(dir, "preload.cjs");
        writeFileSync(
          preload,
          `require('node:fs').writeFileSync(process.env.MARKER, 'executed');`,
        );
        const env = {
          ...process.env,
          RECORD: record,
          MARKER: marker,
          NODE_OPTIONS: `--require "${preload}"`,
        };
        const shell = process.env.ComSpec || "cmd.exe";
        const launch = spawnSync(
          shell,
          [
            "/d",
            "/s",
            "/c",
            `""${join(dir, "start-intelifluxo.cmd")}" "& echo injected > ${marker}""`,
          ],
          { env, encoding: "utf8", windowsVerbatimArguments: true },
        );
        expect(launch.status, launch.stderr).toBe(0);
        expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
          args: [],
          options: null,
          cwd: join(dir, "backend"),
        });
        expect(existsSync(marker)).toBe(false);
        const runPs = (...args: string[]) =>
          spawnSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              join(dir, "start-intelifluxo.ps1"),
              ...args,
            ],
            { env, encoding: "utf8" },
          );
        for (const [args, expected] of [
          [[], []],
          [["-NoOpen"], ["--no-open"]],
          [
            ["-NoInfra", "-NoOpen"],
            ["--no-infra", "--no-open"],
          ],
        ] as [string[], string[]][]) {
          const result = runPs(...args);
          expect(result.status, result.stderr).toBe(0);
          expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
            args: expected,
            options: null,
            cwd: join(dir, "backend"),
          });
          expect(existsSync(marker)).toBe(false);
        }
        rmSync(record);
        const bad = runPs("-Unexpected", `& echo injected > ${marker}`);
        expect(bad.status).not.toBe(0);
        expect(existsSync(record)).toBe(false);
        expect(existsSync(marker)).toBe(false);
        writeFileSync(
          join(dir, "backend/src/runtime-supervisor-main.ts"),
          `require('node:fs').writeFileSync(process.env.RECORD, JSON.stringify({args: process.argv.slice(2), cep: process.env.VIACEP_EXTERNAL_EXECUTION_ENABLED}));`,
        );
        writeFileSync(
          join(dir, "intelifluxo.local.json"),
          JSON.stringify({
            noInfra: true,
            containers: [],
            VIACEP_EXTERNAL_EXECUTION_ENABLED: "true",
          }),
        );
        const configured = runPs("-NoOpen");
        expect(configured.status, configured.stderr).toBe(0);
        expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
          args: ["--no-infra", "--no-open"],
          cep: process.env.VIACEP_EXTERNAL_EXECUTION_ENABLED || "true",
        });
        rmSync(record);
        writeFileSync(
          join(dir, "intelifluxo.local.json"),
          JSON.stringify({ unknown: "value" }),
        );
        expect(runPs("-NoOpen").status).not.toBe(0);
        expect(existsSync(record)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );
});
