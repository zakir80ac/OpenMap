// REQ-CMDB-015 — custom field definitions and values: the Settings editor (administrators), the CI detail editor
// (operators) and the CMDB filter read and write them here.
import { queryOptions } from '@tanstack/react-query';
import type { CustomFieldDefinitionInput, CustomFieldType } from '@openmap/contracts';
import { gql } from './graphql';

export interface CustomFieldDefinitionView {
  id: string;
  key: string;
  labelEn: string;
  labelAr: string;
  description: string;
  type: CustomFieldType;
  options: string[];
  appliesTo: string[];
  required: boolean;
  /** REQ-SEC-011: values stored encrypted; not offered as a filter. */
  sensitive: boolean;
  usage: number;
}

const FIELDS = 'id key labelEn labelAr description type options appliesTo required sensitive usage';
const DEFINITIONS_QUERY = 'query CustomFieldDefinitions($type: String) { customFieldDefinitions(type: $type) { ' + FIELDS + ' } }';
const UPSERT_MUTATION =
  'mutation UpsertCustomFieldDefinition($id: UUID, $input: CustomFieldDefinitionInput!) { upsertCustomFieldDefinition(id: $id, input: $input) { ' + FIELDS + ' } }';
const DELETE_MUTATION = 'mutation DeleteCustomFieldDefinition($id: UUID!) { deleteCustomFieldDefinition(id: $id) }';
const SET_VALUES_MUTATION = 'mutation SetCiCustomFields($ciId: UUID!, $values: JSON!) { setCiCustomFields(ciId: $ciId, values: $values) { id customFields } }';

export const customFieldsQueryKey = ['custom-field-definitions'] as const;

export function customFieldDefinitionsQuery(type: string | null = null) {
  return queryOptions({
    queryKey: [...customFieldsQueryKey, type] as const,
    queryFn: ({ signal }) =>
      gql<{ customFieldDefinitions: CustomFieldDefinitionView[] }>(DEFINITIONS_QUERY, { type }, signal).then((d) => d.customFieldDefinitions),
  });
}

export function upsertCustomFieldDefinition(id: string | null, input: CustomFieldDefinitionInput): Promise<CustomFieldDefinitionView> {
  return gql<{ upsertCustomFieldDefinition: CustomFieldDefinitionView }>(UPSERT_MUTATION, { id, input }).then((d) => d.upsertCustomFieldDefinition);
}

export function deleteCustomFieldDefinition(id: string): Promise<boolean> {
  return gql<{ deleteCustomFieldDefinition: boolean }>(DELETE_MUTATION, { id }).then((d) => d.deleteCustomFieldDefinition);
}

export function setCiCustomFields(ciId: string, values: Record<string, string | number | boolean | null>): Promise<{ id: string; customFields: Record<string, string | number | boolean> }> {
  return gql<{ setCiCustomFields: { id: string; customFields: Record<string, string | number | boolean> } }>(SET_VALUES_MUTATION, { ciId, values }).then((d) => d.setCiCustomFields);
}
