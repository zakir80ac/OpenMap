// REQ-CORE-012 — DateTime scalar: ISO 8601 strings on the wire, Date or ISO string in resolvers.
import { BadRequestException } from '@nestjs/common';
import { Scalar, type CustomScalar } from '@nestjs/graphql';
import { Kind, type ValueNode } from 'graphql';
import { z } from 'zod';

const iso = z.iso.datetime({ offset: true });

export function parseDateTime(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && iso.safeParse(value).success) return new Date(value).toISOString();
  throw new BadRequestException('DateTime must be an ISO 8601 string');
}

@Scalar('DateTime')
export class DateTimeScalar implements CustomScalar<string, string> {
  description = 'ISO 8601 date-time with offset, e.g. 2026-10-22T09:27:15.000Z';

  parseValue(value: unknown): string {
    return parseDateTime(value);
  }

  serialize(value: unknown): string {
    return parseDateTime(value);
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind !== Kind.STRING) throw new BadRequestException('DateTime literal must be a string');
    return parseDateTime(ast.value);
  }
}
