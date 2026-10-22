// REQ-CORE-012 — UUID scalar: RFC 4122 strings, validated on input and output.
import { BadRequestException } from '@nestjs/common';
import { Scalar, type CustomScalar } from '@nestjs/graphql';
import { Kind, type ValueNode } from 'graphql';
import { isUuid } from '../common/uuid.js';

export function parseUuid(value: unknown): string {
  if (isUuid(value)) return value.toLowerCase();
  throw new BadRequestException('UUID must be an RFC 4122 string');
}

@Scalar('UUID')
export class UuidScalar implements CustomScalar<string, string> {
  description = 'RFC 4122 UUID';

  parseValue(value: unknown): string {
    return parseUuid(value);
  }

  serialize(value: unknown): string {
    return parseUuid(value);
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind !== Kind.STRING) throw new BadRequestException('UUID literal must be a string');
    return parseUuid(ast.value);
  }
}
