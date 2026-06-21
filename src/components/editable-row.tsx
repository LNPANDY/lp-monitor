"use client";
import { useState } from "react";

/**
 * 可编辑行组件：默认展示 display，点击「编辑」变成内联编辑表单。
 */
export function EditableRow({
  fields,
  values,
  onSave,
  display,
  actions,
  disabled,
}: {
  fields: { key: string; label: string; placeholder?: string }[];
  values: Record<string, any>;
  onSave: (updates: Record<string, any>) => Promise<void>;
  display?: React.ReactNode;
  actions?: React.ReactNode;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function startEdit() {
    const init: Record<string, any> = {};
    for (const f of fields) init[f.key] = values[f.key] ?? "";
    // 数组字段（如 rpc_urls）转成字符串方便编辑
    for (const k in init) { if (Array.isArray(init[k])) init[k] = (init[k] as string[]).join(" "); }
    setForm(init);
    setEditing(true);
    setErr("");
  }

  async function handleSave() {
    setBusy(true); setErr("");
    try {
      await onSave(form);
      setEditing(false);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="rounded-md border-2 border-ink/20 p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {fields.map((f) => (
            <label key={f.key} className="block">
              <span className="label">{f.label}</span>
              <input
                className="input"
                value={form[f.key] ?? ""}
                placeholder={f.placeholder ?? ""}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        {err && <p className="mt-1 text-xs text-warn">{err}</p>}
        <div className="mt-2 flex gap-2">
          <button className="btn-primary" onClick={handleSave} disabled={busy}>{busy ? "保存中…" : "保存"}</button>
          <button className="btn-ghost" onClick={() => setEditing(false)} disabled={busy}>取消</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">{display}</div>
      <div className="ml-2 flex items-center gap-2">
        {!disabled && <button className="btn-ghost text-xs" onClick={startEdit}>编辑</button>}
        {actions}
      </div>
    </div>
  );
}
