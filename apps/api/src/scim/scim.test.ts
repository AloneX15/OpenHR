import { describe, expect, it } from 'vitest';
import { applyPatch, fromScim, parseFilter } from './scim.service';

describe('SCIM', () => {
  it('entiende los filtros que usa Entra ID y rechaza el resto', () => {
    expect(parseFilter('userName eq "ana@demo.test"')).toEqual({ field: 'email', value: 'ana@demo.test' });
    expect(parseFilter('externalId eq "a\\"b"')).toEqual({ field: 'scim_external_id', value: 'a"b' });
    expect(parseFilter(undefined)).toBeNull();
    expect(() => parseFilter('userName sw "a"')).toThrow();
    expect(() => parseFilter('userName eq "a" or 1 eq 1')).toThrow();
  });

  it('aplica los PATCH de Entra ID (op con mayúscula y booleanos como texto)', () => {
    expect(applyPatch([{ op: 'Replace', path: 'active', value: 'False' }])).toEqual({ active: false });
    expect(applyPatch([{ op: 'replace', value: { active: true, 'name.givenName': 'Ana' } }])).toEqual({ active: true, givenName: 'Ana' });
    expect(applyPatch([{ op: 'Add', path: 'emails[type eq "work"].value', value: 'nueva@demo.test' }])).toEqual({ userName: 'nueva@demo.test' });
    expect(applyPatch([{ op: 'Add', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'X' }])).toEqual({});
    expect(() => applyPatch([{ op: 'move', path: 'active' }])).toThrow();
  });

  it('lee el alta con userName o con el email principal', () => {
    expect(fromScim({ userName: ' a@b.es ', name: { givenName: 'A' }, active: 'true', externalId: 'x' })).toEqual({ userName: 'a@b.es', givenName: 'A', familyName: undefined, active: true, externalId: 'x' });
    expect(fromScim({ emails: [{ value: 'c@d.es', primary: true }] }).userName).toBe('c@d.es');
  });
});
