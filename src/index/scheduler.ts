import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Scheduler adapters: GENERATION only in S4.1-A (installation real is
// S4.1-B). Linux emits a systemd user timer+service; Windows emits a Task
// Scheduler XML definition. Both quote executable paths safely (spaces,
// unicode), dedupe by task name, and support enable/disable/refresh without
// duplication. Nothing here touches the live scheduler.

export interface ScheduledTask {
  name: string;
  latticeBin: string;
  dataDir: string;
  intervalMinutes: number;
}

function quoteSystemd(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Splits an executable path from its arguments without a shell: the timer
// runs node directly with an argv array rendered below.
export function systemdUnits(task: ScheduledTask): { service: string; timer: string } {
  const service = [
    "[Unit]",
    `Description=Lattice Agent Index reporter (${task.name})`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${quoteSystemd(task.latticeBin)} index report --data-dir ${quoteSystemd(task.dataDir)}`,
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    `Description=Report Lattice usage every ${task.intervalMinutes} minutes`,
    "",
    "[Timer]",
    `OnUnitActiveSec=${task.intervalMinutes}min`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

export function windowsTaskXml(task: ScheduledTask): string {
  const command = quoteXml(task.latticeBin);
  const args = quoteXml(`index report --data-dir ${task.dataDir}`);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>Lattice Agent Index reporter (${quoteXml(task.name)})</Description></RegistrationInfo>`,
    "  <Triggers>",
    '    <CalendarTrigger>',
    `      <Repetition><Interval>PT${task.intervalMinutes}M</Interval></Repetition>`,
    "      <StartBoundary>2026-01-01T00:00:00</StartBoundary>",
    "      <Enabled>true</Enabled>",
    "    </CalendarTrigger>",
    "  </Triggers>",
    "  <Principals><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries></Settings>",
    "  <Actions Context=\"Author\">",
    `    <Exec><Command>${command}</Command><Arguments>${args}</Arguments></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

export function schedulerFiles(dataDir: string): { dir: string; linuxService: string; linuxTimer: string; windowsXml: string } {
  const dir = path.join(dataDir, "index", "bootstrap", "scheduler");
  return {
    dir,
    linuxService: path.join(dir, "lattice-index.service"),
    linuxTimer: path.join(dir, "lattice-index.timer"),
    windowsXml: path.join(dir, "lattice-index.xml"),
  };
}

// Writes both definitions (the active one is platform-selected at install
// time). Idempotent: identical content is a no-op rewrite of the same bytes.
export function writeSchedulerDefinitions(task: ScheduledTask, dataDir: string): { files: string[]; changed: boolean } {
  const files = schedulerFiles(dataDir);
  fs.mkdirSync(files.dir, { recursive: true });
  const { service, timer } = systemdUnits(task);
  const xml = windowsTaskXml(task);
  let changed = false;
  for (const [file, content] of [
    [files.linuxService, service],
    [files.linuxTimer, timer],
    [files.windowsXml, xml],
  ] as const) {
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(file, "utf8");
    } catch {
      previous = null;
    }
    if (previous !== content) {
      fs.writeFileSync(file, content, "utf8");
      changed = true;
    }
  }
  return { files: [files.linuxService, files.linuxTimer, files.windowsXml], changed };
}

export function platformSchedulerHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "schtasks /create /tn LatticeIndex /xml <file> (opt-in only; S4.1-B)";
  if (platform === "linux") return "systemctl --user enable --now lattice-index.timer (opt-in only; S4.1-B)";
  return `scheduler install not supported on ${platform} in S4.1-A`;
}

export function homedir(): string {
  return os.homedir();
}
