"use client";

import { useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { effectiveFamily } from "~/server/services/effective-schedule";

type Family = RouterOutputs["curator"]["family"];
type Preview = RouterOutputs["curator"]["previewFamilyName"];

export function FamilyNameForm({
  family,
  onDirtyChange,
  onPublished,
}: {
  family: Family;
  onDirtyChange: (dirty: boolean) => void;
  onPublished: (notice: string) => Promise<void>;
}) {
  const [name, setName] = useState(effectiveFamily(family).name);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [notice, setNotice] = useState("");
  const utils = api.useUtils();
  const save = api.curator.publishFamilyName.useMutation({
    onSuccess: async (result) => {
      onDirtyChange(false);
      await utils.curator.history.invalidate();
      await onPublished(
        result.cacheInvalidated
          ? "Family name saved."
          : "Family name saved. The timeline cache will refresh on its next request.",
      );
    },
    onError: (error) => setNotice(error.message),
  });
  async function loadPreview(nextName: string | null) {
    setPreviewing(true);
    setNotice("");
    setPreview(null);
    onDirtyChange(true);
    try {
      setPreview(
        await utils.curator.previewFamilyName.fetch({
          familyId: family.id,
          name: nextName,
        }),
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not preview the family name.",
      );
    } finally {
      setPreviewing(false);
    }
  }
  return (
    <form
      className="curator-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void loadPreview(name);
      }}
    >
      <fieldset disabled={previewing || save.isPending}>
        <legend>Family name</legend>
        <p>
          This changes the shared family label, not event or banner names,
          dates, rewards or summon plans.
        </p>
        <p>Imported name: {family.name}</p>
        <label>
          Displayed name
          <input
            value={name}
            maxLength={300}
            required
            onChange={(e) => {
              setName(e.target.value);
              setPreview(null);
              onDirtyChange(true);
            }}
          />
        </label>
        <label>
          Reason
          <input
            value={reason}
            minLength={3}
            maxLength={1000}
            required
            onChange={(e) => {
              setReason(e.target.value);
              onDirtyChange(true);
            }}
          />
        </label>
        <div className="curator-actions">
          <button type="submit">
            {previewing ? "Loading preview…" : "Preview name"}
          </button>
          <button
            type="button"
            disabled={!family.curation?.active}
            onClick={() => void loadPreview(null)}
          >
            Preview imported name
          </button>
        </div>
        {preview && (
          <section className="curator-source" aria-label="Family name preview">
            <h3>Preview</h3>
            <dl>
              <dt>Current</dt>
              <dd>{preview.currentName}</dd>
              <dt>New</dt>
              <dd>{preview.nextName}</dd>
            </dl>
            <p>
              {preview.eventIds.length} events and {preview.bannerIds.length}{" "}
              banners use this family label.
            </p>
            <button
              className="curator-primary"
              type="button"
              disabled={reason.trim().length < 3}
              onClick={() =>
                save.mutate({
                  familyId: family.id,
                  name: preview.reset ? null : preview.nextName,
                  fingerprint: preview.fingerprint,
                  reason,
                })
              }
            >
              {save.isPending
                ? "Saving…"
                : preview.reset
                  ? "Use imported name"
                  : "Save family name"}
            </button>
          </section>
        )}
      </fieldset>
      {notice && <p role="alert">{notice}</p>}
    </form>
  );
}

export function CuratorFamilyName({
  familyId,
  onDirtyChange,
}: {
  familyId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const family = api.curator.family.useQuery(
    { id: familyId },
    { refetchOnWindowFocus: false },
  );
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const history = api.curator.history.useQuery(
    { targetKind: "FAMILY", targetId: familyId, page: historyPage },
    { refetchOnWindowFocus: false },
  );
  function changed(value: boolean) {
    setDirty(value);
    onDirtyChange(value);
  }
  async function reload(message = "") {
    const result = await family.refetch();
    if (result.error) {
      setNotice("Could not reload the family. Your edits have been kept.");
      return;
    }
    changed(false);
    setEpoch((value) => value + 1);
    setNotice(message);
  }
  return (
    <details className="curator-family-editor curator-source">
      <summary>Family name</summary>
      {family.isPending && <p role="status">Loading family…</p>}
      {family.error && <p role="alert">{family.error.message}</p>}
      {family.data && (
        <FamilyNameForm
          key={`${familyId}:${epoch}`}
          family={family.data}
          onDirtyChange={changed}
          onPublished={reload}
        />
      )}
      <button
        type="button"
        onClick={() => {
          if (
            !dirty ||
            window.confirm("Discard unsaved family changes and reload?")
          )
            void reload();
        }}
      >
        Reload family
      </button>
      {notice && <p role="status">{notice}</p>}
      <details className="curator-history">
        <summary>Family name history</summary>
        {history.isPending && <p role="status">Loading history…</p>}
        {history.error && <p role="alert">{history.error.message}</p>}
        {!history.isPending && history.data?.length === 0 && (
          <p>No family name changes recorded.</p>
        )}
        {history.data?.map((change) => (
          <details key={change.id}>
            <summary>
              {change.createdAt.toISOString().slice(0, 16).replace("T", " ")}{" "}
              UTC · {change.reason}
            </summary>
            <pre>
              {JSON.stringify(
                { before: change.before, after: change.after },
                null,
                2,
              )}
            </pre>
          </details>
        ))}
        <div className="curator-actions">
          <button
            disabled={historyPage === 0}
            onClick={() => setHistoryPage((page) => page - 1)}
          >
            Newer changes
          </button>
          <button
            disabled={(history.data?.length ?? 0) < 25}
            onClick={() => setHistoryPage((page) => page + 1)}
          >
            Older changes
          </button>
        </div>
      </details>
    </details>
  );
}
