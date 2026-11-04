import { describe, expect, test } from 'bun:test';
import {
  cancellationScopeIncludes,
  readShownCancellationCandidates,
  renderCancellationClarification,
} from '../src/modules/tools/reminder-cancel-scope.js';

const candidates = [
  { id: 'first', wall_time: '2027-11-04 09:20', timezone_id: 'Asia/Shanghai' },
  { id: 'second', wall_time: '2027-11-05 09:20', timezone_id: 'Asia/Shanghai' },
];

describe('independent cancellation scope', () => {
  test.each([
    ['取消“同名提醒”11月5日那条', null, 'second', true],
    ['取消“同名提醒”11月5日那条', null, 'first', false],
    ['取消“同名提醒”11月5日上午9点20分那条', null, 'second', true],
    ['取消“同名提醒”11月5日下午9点20分那条', null, 'second', false],
    ['取消“同名提醒”的全部提醒', null, 'first', true],
    ['取消所有名叫“同名提醒”的提醒', null, 'second', true],
    ['不要取消“同名提醒”11月5日那条', null, 'second', false],
    ['取消“同名提醒”的全部提醒？', null, 'second', false],
    ['取消“同名提醒”，除了11月5日的其他全部取消', null, 'second', false],
    ['11月5日那条', '帮我取消“同名提醒”这条提醒', 'second', true],
    ['全部', '帮我取消“同名提醒”这条提醒', 'second', true],
    ['不要全部', '帮我取消“同名提醒”这条提醒', 'second', false],
    ['11月5日那条', '不要取消“同名提醒”', 'second', false],
    ['第二条', '帮我取消“同名提醒”这条提醒', 'second', false],
    ['取消“其他提醒”11月5日那条', null, 'second', false],
  ])('%s', (input, original, target, expected) => {
    expect(cancellationScopeIncludes(input, original, '同名提醒', candidates, target)).toBe(
      expected,
    );
  });

  test('a named reminder before the title is unique only with one live candidate', () => {
    expect(
      cancellationScopeIncludes(
        '请取消提醒“同名提醒”。',
        null,
        '同名提醒',
        [candidates[0]!],
        'first',
      ),
    ).toBe(true);
    expect(
      cancellationScopeIncludes('请取消提醒“同名提醒”。', null, '同名提醒', candidates, 'first'),
    ).toBe(false);
  });

  test('an explicit cancellation can resolve the single candidate shown in a clarification', () => {
    const candidate = {
      id: '12345678-1234-4234-8234-123456789abc',
      wall_time: '2027-11-04 09:20',
      timezone_id: 'Asia/Shanghai',
    };
    const shown = readShownCancellationCandidates(renderCancellationClarification([candidate]));
    expect(shown).toEqual([candidate]);
    expect(
      cancellationScopeIncludes('第一条', '不要取消', '提醒', [candidate], candidate.id, shown),
    ).toBe(false);
    expect(
      cancellationScopeIncludes('取消第一条', '不要取消', '提醒', [candidate], candidate.id, shown),
    ).toBe(false);
    expect(
      cancellationScopeIncludes(
        '第一条',
        '取消“提醒”11月4日那条',
        '提醒',
        [candidate],
        candidate.id,
        shown,
      ),
    ).toBe(true);
    expect(
      cancellationScopeIncludes(
        '取消第一条',
        '不要取消',
        '提醒',
        [{ ...candidate, wall_time: '2027-11-05 09:20' }],
        candidate.id,
        shown,
      ),
    ).toBe(false);
  });

  test('a shown ordinal must remain inside the original dated target scope', () => {
    const shown = [
      { id: 'first', wall_time: '2027-11-05 09:00', timezone_id: 'Asia/Shanghai' },
      { id: 'second', wall_time: '2027-11-05 10:00', timezone_id: 'Asia/Shanghai' },
    ];
    expect(
      cancellationScopeIncludes('第二条', '取消“喝水”11月5日那条', '喝水', shown, 'second', shown),
    ).toBe(true);
    expect(
      cancellationScopeIncludes(
        '取消第二条',
        '取消“喝水”11月5日那条',
        '吃药',
        shown,
        'second',
        shown,
      ),
    ).toBe(false);
    expect(
      cancellationScopeIncludes('第二条', '取消“喝水”11月4日那条', '喝水', shown, 'second', shown),
    ).toBe(false);
  });

  test('a date alone cannot choose between two reminders on that date', () => {
    expect(
      cancellationScopeIncludes(
        '取消“同名提醒”11月5日那条',
        null,
        '同名提醒',
        [
          ...candidates,
          { id: 'third', wall_time: '2027-11-05 10:20', timezone_id: 'Asia/Shanghai' },
        ],
        'second',
      ),
    ).toBe(false);
  });

  test('exact times and timezones distinguish same-date reminders', () => {
    const sameDay = [
      ...candidates,
      { id: 'third', wall_time: '2027-11-05 10:20', timezone_id: 'Asia/Shanghai' },
    ];
    expect(
      cancellationScopeIncludes(
        '取消“同名提醒”11月5日10:20那条',
        null,
        '同名提醒',
        sameDay,
        'third',
      ),
    ).toBe(true);
    const differentZone = [
      ...sameDay,
      { id: 'fourth', wall_time: '2027-11-05 10:20', timezone_id: 'America/New_York' },
    ];
    expect(
      cancellationScopeIncludes(
        '取消“同名提醒”11月5日10:20那条',
        null,
        '同名提醒',
        differentZone,
        'third',
      ),
    ).toBe(false);
    expect(
      cancellationScopeIncludes(
        '取消“同名提醒”11月5日10:20那条时区Asia/Shanghai',
        null,
        '同名提醒',
        differentZone,
        'third',
      ),
    ).toBe(true);
  });

  test('an explicitly supplied full task ID selects exactly that candidate', () => {
    const id = '12345678-1234-4234-8234-123456789abc';
    const options = [
      ...candidates,
      { id, wall_time: '2027-11-05 09:20', timezone_id: 'Asia/Shanghai' },
    ];
    expect(
      cancellationScopeIncludes(
        `编号${id}那条`,
        '帮我取消“同名提醒”这条提醒',
        '同名提醒',
        options,
        id,
      ),
    ).toBe(true);
    expect(
      cancellationScopeIncludes(
        `编号${id}那条`,
        '帮我取消“同名提醒”这条提醒',
        '同名提醒',
        options,
        'second',
      ),
    ).toBe(false);
  });
});
