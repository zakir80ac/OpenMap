'use client';
// REQ-CMDB-013 REQ-CMDB-016 — editing a CI by hand on its detail page: operators move it through its lifecycle
// (discovered, managed, planned, retired) and replace its tags; everyone else reads them. Tags are suggested from the
// tenant's most used ones; the server trims, de-duplicates and validates them. Both writes are audited.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CI_EDIT, ROLES } from '@openmap/constants';
import { LIFECYCLES } from '@openmap/contracts';
import { Tag } from '@openmap/ui';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, TextInput } from '@/components/common/controls';
import { useCan } from '@/lib/auth';
import { ciTagsQuery, setCiLifecycle, setCiTags, type CiDetail, type Lifecycle } from '@/lib/queries';
import { useT } from '@/providers';
import type { AsyncAction } from './types';

const TAG = new RegExp(CI_EDIT.tagPattern, 'u');

/** Refreshes everything that shows the CI after an edit (its detail, the list, the tag counts). */
function useInvalidateCi(ciId: string): AsyncAction {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['ci', ciId] });
    await queryClient.invalidateQueries({ queryKey: ['cis'] });
    await queryClient.invalidateQueries({ queryKey: ['ci-tags'] });
  };
}

/** The lifecycle as a tag for readers, a select for operators. */
export function LifecycleField({ ci }: { ci: Pick<CiDetail, 'id' | 'lifecycle'> }): ReactNode {
  const t = useT();
  const can = useCan();
  const invalidate = useInvalidateCi(ci.id);
  const mutation = useMutation({ mutationFn: (next: Lifecycle) => setCiLifecycle(ci.id, next), onSuccess: invalidate });
  if (!can(ROLES.operator)) return <Tag>{t(`lifecycle.${ci.lifecycle}`)}</Tag>;
  return (
    <label className="flex items-center gap-om-6 text-om-2xs text-om-muted">
      <span>{t('cmdb.detail.lifecycle')}</span>
      <select
        value={ci.lifecycle}
        disabled={mutation.isPending}
        onChange={(event) => {
          mutation.mutate(event.target.value as Lifecycle);
        }}
        className="h-7 rounded-om-control border border-om-border-glass bg-om-surface1/80 px-om-6 text-om-xs text-om-primary"
      >
        {LIFECYCLES.map((value) => (
          <option key={value} value={value}>
            {t(`lifecycle.${value}`)}
          </option>
        ))}
      </select>
      {mutation.isError ? (
        <span role="alert" className="text-om-rose">
          {t('cmdb.detail.saveFailed')}
        </span>
      ) : null}
    </label>
  );
}

/** The CI's tags; operators remove one with its button or add one from the field (suggested from the tenant's tags). */
export function TagEditor({ ci }: { ci: Pick<CiDetail, 'id' | 'tags'> }): ReactNode {
  const t = useT();
  const can = useCan();
  const fieldId = useId();
  const listId = useId();
  const invalidate = useInvalidateCi(ci.id);
  const [draft, setDraft] = useState('');
  const editable = can(ROLES.operator);
  const suggestions = useQuery({ ...ciTagsQuery(), enabled: editable });
  const mutation = useMutation({
    mutationFn: (tags: string[]) => setCiTags(ci.id, tags),
    onSuccess: async () => {
      setDraft('');
      await invalidate();
    },
  });
  const candidate = draft.trim();
  const valid = candidate.length > 0 && candidate.length <= CI_EDIT.maxTagLength && TAG.test(candidate) && !ci.tags.includes(candidate);
  const full = ci.tags.length >= CI_EDIT.maxTags;
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!valid || full) return;
    mutation.mutate([...ci.tags, candidate]);
  };
  return (
    <div className="flex flex-col gap-om-10">
      {ci.tags.length === 0 ? (
        <p className="text-om-sm text-om-secondary">{t('cmdb.detail.noTags')}</p>
      ) : (
        <ul className="flex flex-wrap gap-om-6" aria-label={t('cmdb.detail.tags')}>
          {ci.tags.map((tag) => (
            <li key={tag} className="flex items-center gap-om-2">
              <Tag>{tag}</Tag>
              {editable ? (
                <Button
                  tone="quiet"
                  className="px-om-4 text-om-2xs"
                  aria-label={t('cmdb.detail.tagRemove', { tag })}
                  disabled={mutation.isPending}
                  onClick={() => {
                    mutation.mutate(ci.tags.filter((x) => x !== tag));
                  }}
                >
                  ×
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-om-8">
          <label htmlFor={fieldId} className="flex min-w-48 flex-1 flex-col gap-om-4 text-om-2xs text-om-muted">
            {t('cmdb.detail.tagAdd')}
            <TextInput
              id={fieldId}
              list={listId}
              value={draft}
              maxLength={CI_EDIT.maxTagLength}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
          </label>
          <datalist id={listId}>
            {(suggestions.data ?? []).map((s) => (
              <option key={s.tag} value={s.tag} />
            ))}
          </datalist>
          <Button type="submit" disabled={!valid || full || mutation.isPending}>
            {t('cmdb.detail.tagAddButton')}
          </Button>
          {candidate.length > 0 && !valid ? <span className="text-om-2xs text-om-amber">{t('cmdb.detail.tagInvalid')}</span> : null}
          {mutation.isError ? (
            <span role="alert" className="text-om-2xs text-om-rose">
              {t('cmdb.detail.saveFailed')}
            </span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
