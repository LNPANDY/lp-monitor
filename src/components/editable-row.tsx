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
  fields: {
    key: string;
    label: string;
    placeholder?: string;
    type?: string;
    options?: Array<{ value: string; label: string }>;
  }[];
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
    for (const k in init) {
      if (Array.isArray(init[k])) init[k] = (init[k] as string[]).join(" ");
    }
    setForm(init);
    setEditing(true);
    setErr("");
  }

  async function handleSave() {
    setBusy(true);
    setErr("");
    try {
      await onSave(form);
      setEditing(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-brand/40 bg-surface-raised/90 p-3 space-y-2.5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {fields.map((f) => (
            <label key={f.key} className="block">
              <span className="label">{f.label}</span>
              {f.type === "select" ? (
                <select
                  className="input"
                  value={form[f.key] ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, [f.key]: e.target.value })
                  }
                >
                  <option value="">无关联</option>
                  {f.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  value={form[f.key] ?? ""}
                  placeholder={f.placeholder ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, [f.key]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
        </div>
        {err && <p className="text-xs text-danger">{err}</p>}
        <div className="flex gap-2">
          <button
            className="btn-primary btn-xs"
            onClick={handleSave}
            disabled={busy}
          >
            {busy ? "保存中…" : "保存"}
          </button>
          <button
            className="btn-ghost btn-xs"
            onClick={() => setEditing(false)}
            disabled={busy}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-surface-raised/40 px-3 py-2 text-sm hover:border-white/[0.15] transition">
      <div className="min-w-0 flex-1">{display}</div>
      <div className="flex items-center gap-2 shrink-0">
        {!disabled && (
          <button className="btn-ghost btn-xs" onClick={startEdit}>
            编辑
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}
