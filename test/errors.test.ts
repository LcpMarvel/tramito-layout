import { describe, expect, it } from 'bun:test';
import { InternalCompilerError, asCompileError, runStage, withCompileErrors } from '../src/errors.ts';
import { layoutBpmnXml } from '../src/index.ts';

describe('编译错误分层 (asCompileError)', () => {
  it('wraps a backend Error as InternalCompilerError and extracts the stage tag', () => {
    const wrapped = asCompileError(new Error('[edge-router] local obstacle detour did not converge'));
    expect(wrapped).toBeInstanceOf(InternalCompilerError);
    const ice = wrapped as InternalCompilerError;
    expect(ice.internal).toBe(true);
    expect(ice.stage).toBe('edge-router');
    expect(ice.message).toContain('请勿把此错误回喂给生成模型');
  });

  it('passes validation AggregateError through untouched (user-fixable)', () => {
    const agg = new AggregateError([new Error('x')], 'validation');
    expect(asCompileError(agg)).toBe(agg);
  });

  it('is idempotent — does not double-wrap an InternalCompilerError', () => {
    const ice = new InternalCompilerError('boom', { stage: 'merger' });
    expect(asCompileError(ice)).toBe(ice);
  });

  it('withCompileErrors rethrows backend throws as ICE', async () => {
    await expect(
      withCompileErrors(async () => {
        throw new Error('[merger] route r1 has incomplete waypoints');
      }),
    ).rejects.toBeInstanceOf(InternalCompilerError);
  });

  // runStage 是 F3 的权威归属：phase 内联逻辑抛的错没有 [xxx] 前缀，以前 stage 悬空，
  // 现在必须由 runStage 的名字兜底；message 自带前缀时仍以更精确的 message 为准。
  it('runStage attributes ICE to the phase name when the throw has no [stage] prefix', async () => {
    let caught: unknown;
    try {
      await runStage('edge-router', () => {
        throw new Error('local obstacle detour did not converge');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternalCompilerError);
    expect((caught as InternalCompilerError).stage).toBe('edge-router');
  });

  it('runStage keeps the more precise [stage] prefix from the original message', async () => {
    let caught: unknown;
    try {
      await runStage('merger', () => {
        throw new Error('[path-shaper] Z-shape corridor collapsed');
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as InternalCompilerError).stage).toBe('path-shaper');
  });

  it('runStage passes AggregateError (validation) through untouched', async () => {
    const agg = new AggregateError([new Error('x')], 'validation');
    let caught: unknown;
    try {
      await runStage('loader', () => {
        throw agg;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(agg);
  });
});

describe('编译边界 — 校验错 vs ICE', () => {
  it('layoutBpmnXml surfaces a validation error as AggregateError, NOT ICE', async () => {
    // 结构错（boundaryEvent 放进 children）应是用户可改的校验错，原样抛 AggregateError。
    const bad = {
      id: 'defs',
      children: [{ id: 'p', bpmn: { type: 'process' }, children: [{ id: 'be', bpmn: { type: 'boundaryEvent' } }] }],
    };
    let caught: unknown;
    try {
      await layoutBpmnXml(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).not.toBeInstanceOf(InternalCompilerError);
  });
});
