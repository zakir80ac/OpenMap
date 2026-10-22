// REQ-CORE-012 — JSON scalar: arbitrary JSON values (CI attributes, identities, event payloads).
import { BadRequestException } from '@nestjs/common';
import { Scalar, type CustomScalar } from '@nestjs/graphql';
import { Kind, type ValueNode } from 'graphql';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type Variables = Record<string, unknown> | null | undefined;

export function jsonFromAst(ast: ValueNode, variables: Variables): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return ast.value;
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map((v) => jsonFromAst(v, variables));
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const f of ast.fields) out[f.name.value] = jsonFromAst(f.value, variables);
      return out;
    }
    case Kind.VARIABLE:
      return variables ? variables[ast.name.value] : undefined;
  }
}

function assertJson(value: unknown): unknown {
  if (value === undefined) throw new BadRequestException('JSON value must not be undefined');
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new BadRequestException('value is not JSON');
  return value;
}

@Scalar('JSON')
export class JsonScalar implements CustomScalar<unknown, unknown> {
  description = 'Arbitrary JSON value';

  parseValue(value: unknown): unknown {
    return assertJson(value);
  }

  serialize(value: unknown): unknown {
    return assertJson(value);
  }

  parseLiteral(ast: ValueNode, variables?: Variables): unknown {
    return assertJson(jsonFromAst(ast, variables));
  }
}
