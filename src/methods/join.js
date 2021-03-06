/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { Binding } from "../environment.js";
import { FatalError } from "../errors.js";
import type { Bindings, BindingEntry, EvaluationResult, PropertyBindings, CreatedObjects, Realm } from "../realm.js";
import { Effects } from "../realm.js";
import type { Descriptor, PropertyBinding } from "../types.js";

import {
  AbruptCompletion,
  BreakCompletion,
  Completion,
  ContinueCompletion,
  PossiblyNormalCompletion,
  ForkedAbruptCompletion,
  SimpleNormalCompletion,
  NormalCompletion,
  ReturnCompletion,
  ThrowCompletion,
} from "../completions.js";
import { Reference } from "../environment.js";
import { cloneDescriptor, equalDescriptors, IsDataDescriptor, StrictEqualityComparison } from "../methods/index.js";
import { construct_empty_effects } from "../realm.js";
import { Path } from "../singletons.js";
import { Generator } from "../utils/generator.js";
import { AbstractValue, ConcreteValue, EmptyValue, Value } from "../values/index.js";

import invariant from "../invariant.js";

function joinGenerators(
  realm: Realm,
  joinCondition: AbstractValue,
  generator1: Generator,
  generator2: Generator
): Generator {
  // TODO #2222: Check if `realm.pathConditions` is correct here.
  let result = new Generator(realm, "joined", realm.pathConditions);
  if (!generator1.empty() || !generator2.empty()) {
    result.joinGenerators(joinCondition, generator1, generator2);
  }
  return result;
}

function joinArrays(
  realm: Realm,
  v1: void | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
  v2: void | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
  getAbstractValue: (void | Value, void | Value) => Value
): Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }> {
  let e = (v1 && v1[0]) || (v2 && v2[0]);
  if (e instanceof Value) return joinArraysOfValues(realm, (v1: any), (v2: any), getAbstractValue);
  else return joinArrayOfsMapEntries(realm, (v1: any), (v2: any), getAbstractValue);
}

function joinArrayOfsMapEntries(
  realm: Realm,
  a1: void | Array<{ $Key: void | Value, $Value: void | Value }>,
  a2: void | Array<{ $Key: void | Value, $Value: void | Value }>,
  getAbstractValue: (void | Value, void | Value) => Value
): Array<{ $Key: void | Value, $Value: void | Value }> {
  let empty = realm.intrinsics.empty;
  let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
  let result = [];
  for (let i = 0; i < n; i++) {
    let { $Key: key1, $Value: val1 } = (a1 && a1[i]) || { $Key: empty, $Value: empty };
    let { $Key: key2, $Value: val2 } = (a2 && a2[i]) || { $Key: empty, $Value: empty };
    if (key1 === undefined && key2 === undefined) {
      result[i] = { $Key: undefined, $Value: undefined };
    } else {
      let key3 = getAbstractValue(key1, key2);
      let val3 = getAbstractValue(val1, val2);
      result[i] = { $Key: key3, $Value: val3 };
    }
  }
  return result;
}

function joinArraysOfValues(
  realm: Realm,
  a1: void | Array<Value>,
  a2: void | Array<Value>,
  getAbstractValue: (void | Value, void | Value) => Value
): Array<Value> {
  let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
  let result = [];
  for (let i = 0; i < n; i++) {
    result[i] = getAbstractValue((a1 && a1[i]) || undefined, (a2 && a2[i]) || undefined);
  }
  return result;
}

export class JoinImplementation {
  stopEffectCaptureJoinApplyAndReturnCompletion(
    c1: PossiblyNormalCompletion,
    c2: AbruptCompletion,
    realm: Realm
  ): ForkedAbruptCompletion {
    let e = realm.getCapturedEffects();
    realm.stopEffectCaptureAndUndoEffects(c1);
    return this.replacePossiblyNormalCompletionWithForkedAbruptCompletion(realm, c1, c2, e);
  }

  unbundleNormalCompletion(
    completionOrValue: Completion | Value | Reference
  ): [void | NormalCompletion, Value | Reference] {
    let completion, value;
    if (completionOrValue instanceof PossiblyNormalCompletion) {
      completion = completionOrValue;
      value = completionOrValue.value;
    } else {
      invariant(completionOrValue instanceof Value || completionOrValue instanceof Reference);
      value = completionOrValue;
    }
    return [completion, value];
  }

  composeNormalCompletions(
    leftCompletion: void | NormalCompletion,
    rightCompletion: void | NormalCompletion,
    resultValue: Value,
    realm: Realm
  ): PossiblyNormalCompletion | Value {
    if (leftCompletion instanceof PossiblyNormalCompletion) {
      if (rightCompletion instanceof PossiblyNormalCompletion) {
        this.updatePossiblyNormalCompletionWithValue(realm, rightCompletion, resultValue);
        return this.composePossiblyNormalCompletions(realm, leftCompletion, rightCompletion);
      }
      this.updatePossiblyNormalCompletionWithValue(realm, leftCompletion, resultValue);
      return leftCompletion;
    } else if (rightCompletion instanceof PossiblyNormalCompletion) {
      this.updatePossiblyNormalCompletionWithValue(realm, rightCompletion, resultValue);
      return rightCompletion;
    } else {
      invariant(leftCompletion === undefined && rightCompletion === undefined);
      return resultValue;
    }
  }

  composePossiblyNormalCompletions(
    realm: Realm,
    pnc: PossiblyNormalCompletion,
    c: PossiblyNormalCompletion,
    priorEffects?: Effects
  ): PossiblyNormalCompletion {
    invariant(c.savedEffects === undefined); // the caller should ensure this
    let savedPathConditions = pnc.savedPathConditions;
    if (pnc.consequent instanceof AbruptCompletion) {
      let ae = pnc.alternateEffects;
      let na;
      if (pnc.alternate instanceof SimpleNormalCompletion) {
        na = c.shallowCloneWithoutEffects();
        let newAlternateEffects = ae.shallowCloneWithResult(na);
        if (priorEffects) newAlternateEffects = realm.composeEffects(priorEffects, newAlternateEffects);
        return new PossiblyNormalCompletion(
          c.value,
          pnc.joinCondition,
          pnc.consequent,
          newAlternateEffects.result,
          savedPathConditions,
          pnc.savedEffects
        );
      }
      invariant(pnc.alternate instanceof PossiblyNormalCompletion);
      na = this.composePossiblyNormalCompletions(realm, pnc.alternate, c, priorEffects);
      ae.shallowCloneWithResult(na);
      return new PossiblyNormalCompletion(
        c.value,
        pnc.joinCondition,
        pnc.consequent,
        na,
        savedPathConditions,
        pnc.savedEffects
      );
    } else {
      let ce = pnc.consequentEffects;
      let nc;
      if (pnc.consequent instanceof SimpleNormalCompletion) {
        nc = c.shallowCloneWithoutEffects();
        let newConsequentEffects = ce.shallowCloneWithResult(nc);
        if (priorEffects) newConsequentEffects = realm.composeEffects(priorEffects, newConsequentEffects);
        return new PossiblyNormalCompletion(
          c.value,
          pnc.joinCondition,
          newConsequentEffects.result,
          pnc.alternate,
          savedPathConditions,
          pnc.savedEffects
        );
      }
      invariant(pnc.consequent instanceof PossiblyNormalCompletion);
      nc = this.composePossiblyNormalCompletions(realm, pnc.consequent, c);
      ce.shallowCloneWithResult(nc);
      return new PossiblyNormalCompletion(
        c.value,
        pnc.joinCondition,
        nc,
        pnc.alternate,
        savedPathConditions,
        pnc.savedEffects
      );
    }
  }

  updatePossiblyNormalCompletionWithSubsequentEffects(
    realm: Realm,
    pnc: PossiblyNormalCompletion,
    subsequentEffects: Effects
  ): void {
    let v = subsequentEffects.result;
    invariant(v instanceof SimpleNormalCompletion);
    pnc.value = v.value;
    if (pnc.consequent instanceof AbruptCompletion) {
      if (pnc.alternate instanceof SimpleNormalCompletion) {
        let ce = realm.composeEffects(pnc.alternateEffects, subsequentEffects);
        pnc.alternate = ce.result;
      } else {
        invariant(pnc.alternate instanceof PossiblyNormalCompletion);
        this.updatePossiblyNormalCompletionWithSubsequentEffects(realm, pnc.alternate, subsequentEffects);
      }
    } else {
      if (pnc.consequent instanceof SimpleNormalCompletion) {
        let ce = realm.composeEffects(pnc.consequentEffects, subsequentEffects);
        pnc.consequent = ce.result;
      } else {
        invariant(pnc.consequent instanceof PossiblyNormalCompletion);
        this.updatePossiblyNormalCompletionWithSubsequentEffects(realm, pnc.consequent, subsequentEffects);
      }
      if (pnc.alternate instanceof SimpleNormalCompletion) {
        let ce = realm.composeEffects(pnc.alternateEffects, subsequentEffects);
        pnc.alternate = ce.result;
      } else if (pnc.alternate instanceof PossiblyNormalCompletion) {
        this.updatePossiblyNormalCompletionWithSubsequentEffects(realm, pnc.alternate, subsequentEffects);
      }
    }
  }

  updatePossiblyNormalCompletionWithValue(realm: Realm, pnc: PossiblyNormalCompletion, v: Value): void {
    let updateNonAbruptCompletionWithValue = (c: Completion, val: Value) => {
      if (c instanceof SimpleNormalCompletion) {
        c.value = v;
      } else if (c instanceof PossiblyNormalCompletion) {
        this.updatePossiblyNormalCompletionWithValue(realm, c, val);
      } else {
        invariant(false);
      }
    };
    pnc.value = v;
    let pncc = pnc.consequent;
    let pnca = pnc.alternate;
    if (pncc instanceof AbruptCompletion) {
      Path.withInverseCondition(pnc.joinCondition, () => {
        let sv = v instanceof AbstractValue ? realm.simplifyAndRefineAbstractValue(v) : v;
        updateNonAbruptCompletionWithValue(pnca, sv);
      });
    } else {
      Path.withCondition(pnc.joinCondition, () => {
        let sv = v instanceof AbstractValue ? realm.simplifyAndRefineAbstractValue(v) : v;
        updateNonAbruptCompletionWithValue(pncc, sv);
      });
      if (!(pnca instanceof AbruptCompletion)) {
        Path.withInverseCondition(pnc.joinCondition, () => {
          let sv = v instanceof AbstractValue ? realm.simplifyAndRefineAbstractValue(v) : v;
          updateNonAbruptCompletionWithValue(pnca, sv);
        });
      }
    }
  }

  replacePossiblyNormalCompletionWithForkedAbruptCompletion(
    realm: Realm,
    // a forked path with a non abrupt (normal) component
    pnc: PossiblyNormalCompletion,
    // an abrupt completion that completes the normal path
    ac: AbruptCompletion,
    // effects collected after pnc was constructed
    e: Effects
  ): ForkedAbruptCompletion {
    let recurse = (xpnc, xe, nac, ne): ForkedAbruptCompletion => {
      let nx = this.replacePossiblyNormalCompletionWithForkedAbruptCompletion(realm, xpnc, nac, ne);
      xe.shallowCloneWithResult(nx);
      return nx;
    };

    let cloneEffects = () => {
      let nac = ac.shallowCloneWithoutEffects();
      let ne = e.shallowCloneWithResult(nac);
      return [nac, ne];
    };

    ac = ac.shallowCloneWithoutEffects();
    e.result = ac;
    ac.effects = e;

    // # match (pncc, pnca)
    let pncc = pnc.consequent;
    let pnca = pnc.alternate;

    // * case (AbruptCompletion, SimpleNormalCompletion)
    // * case (AbruptCompletion, PossiblyNormalCompletion)
    if (pncc instanceof AbruptCompletion) {
      if (pnca instanceof SimpleNormalCompletion) {
        // todo: simplify with implied path condition
        e = realm.composeEffects(pnc.alternateEffects, e);
        invariant(e.result instanceof AbruptCompletion);
        return new ForkedAbruptCompletion(realm, pnc.joinCondition, pncc, e.result);
      }
      invariant(pnca instanceof PossiblyNormalCompletion);
      let na = recurse(pnca, pnc.alternateEffects, ac, e);
      return new ForkedAbruptCompletion(realm, pnc.joinCondition, pncc, na);
    }

    // * case (SimpleNormalCompletion, AbruptCompletion)
    // * case (PossiblyNormalCompletion, AbruptCompletion)
    if (pnca instanceof AbruptCompletion) {
      if (pncc instanceof SimpleNormalCompletion) {
        // todo: simplify with implied path condition
        e = realm.composeEffects(pnc.consequentEffects, e);
        invariant(e.result instanceof AbruptCompletion);
        return new ForkedAbruptCompletion(realm, pnc.joinCondition, e.result, pnca);
      }
      invariant(pncc instanceof PossiblyNormalCompletion);
      let nc = recurse(pncc, pnc.consequentEffects, ac, e);
      return new ForkedAbruptCompletion(realm, pnc.joinCondition, nc, pnca);
    }

    // * case (SimpleNormalCompletion, SimpleNormalCompletion)
    // * case (SimpleNormalCompletion, PossibleNormalCompletion)
    if (pncc instanceof SimpleNormalCompletion) {
      let nce = realm.composeEffects(pnc.consequentEffects, e);
      invariant(nce.result instanceof AbruptCompletion);
      let nc = nce.result;
      [ac, e] = cloneEffects();
      let na, nae;
      if (pnca instanceof SimpleNormalCompletion) {
        nae = realm.composeEffects(pnc.alternateEffects, e);
        invariant(nae.result instanceof AbruptCompletion);
        na = nae.result;
      } else {
        invariant(pnca instanceof PossiblyNormalCompletion);
        na = recurse(pnca, pnc.alternateEffects, ac, e);
      }
      return new ForkedAbruptCompletion(realm, pnc.joinCondition, nc, na);
    }

    // * case (PossibleNormalCompletion, SimpleNormalCompletion)
    if (pnca instanceof SimpleNormalCompletion) {
      let nae = realm.composeEffects(pnc.alternateEffects, e);
      invariant(nae.result instanceof AbruptCompletion);
      let na = nae.result;
      invariant(pncc instanceof PossiblyNormalCompletion);
      [ac, e] = cloneEffects();
      let nc = recurse(pncc, pnc.consequentEffects, ac, e);
      return new ForkedAbruptCompletion(realm, pnc.joinCondition, nc, na);
    }

    // * case (PossibleNormalCompletion, PossibleNormalCompletion)
    invariant(pncc instanceof PossiblyNormalCompletion);
    invariant(pnca instanceof PossiblyNormalCompletion);
    let nc = recurse(pncc, pnc.consequentEffects, ac, e);
    [ac, e] = cloneEffects();
    let na = recurse(pnca, pnc.alternateEffects, ac, e);
    return new ForkedAbruptCompletion(realm, pnc.joinCondition, nc, na);

    // Impossible cases:
    // * case (AbruptCompletion, AbruptCompletion)
  }

  joinNormalCompletions(
    realm: Realm,
    joinCondition: AbstractValue,
    c: NormalCompletion,
    ce: Effects,
    a: NormalCompletion,
    ae: Effects
  ): PossiblyNormalCompletion {
    let getAbstractValue = (v1: void | Value, v2: void | Value): Value => {
      if (v1 instanceof EmptyValue) return v2 || realm.intrinsics.undefined;
      if (v2 instanceof EmptyValue) return v1 || realm.intrinsics.undefined;
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    let rv = this.joinValues(realm, c.value, a.value, getAbstractValue);
    invariant(rv instanceof Value);
    a.value = rv;
    return new PossiblyNormalCompletion(rv, joinCondition, c, a, []);
  }

  // Join all effects that result in completions of type CompletionType.
  // Erase all completions of type Completion type from c, so that we never join them again.
  // Also erase any generators that appears in branches resulting in completions of type CompletionType.
  // Note that c is modified in place and should be replaced with a PossiblyNormalCompletion by the caller
  // if either of its branches cease to be an AbruptCompletion.
  extractAndJoinCompletionsOfType(CompletionType: typeof AbruptCompletion, realm: Realm, c: AbruptCompletion): Effects {
    let emptyEffects = construct_empty_effects(realm);
    if (c instanceof CompletionType) {
      emptyEffects.result = c.shallowCloneWithoutEffects();
      return emptyEffects;
    }
    if (!(c instanceof ForkedAbruptCompletion)) {
      return emptyEffects;
    }
    // Join up the consequent and alternate completions and compose them with their prefix effects
    let ce = this.extractAndJoinCompletionsOfType(CompletionType, realm, c.consequent);
    // ce will be applied to the global state before any non joining branches in c.consequent, so move
    // the generator from c.consequentEffects to ce.generator so that all branches will see its effects.
    ce = realm.composeEffects(c.consequentEffects, ce);
    // ce now incorporates c.consequentEffects.generator, so remove it from there.
    c.consequentEffects.generator = emptyEffects.generator;
    if (ce.result instanceof CompletionType) {
      // Erase completions of type CompletionType and prepare for transformation of c to a possibly normal completion
      if (c.consequent instanceof CompletionType) {
        c.updateConsequentKeepingCurrentEffects(new SimpleNormalCompletion(realm.intrinsics.empty, undefined));
      } else if (c.consequent instanceof ForkedAbruptCompletion && c.consequent.containsCompletion(NormalCompletion)) {
        c.updateConsequentKeepingCurrentEffects((c.consequent.transferChildrenToPossiblyNormalCompletion(): any));
      }
    } else {
      ce.result = new CompletionType(realm.intrinsics.empty);
    }
    let ae = this.extractAndJoinCompletionsOfType(CompletionType, realm, c.alternate);
    // ae will be applied to the global state before any non joining branches in c.alternate, so move
    // the generator from c.alternateEffects to ae.generator so that all branches will see its effects.
    ae = realm.composeEffects(c.alternateEffects, ae);
    // ae now incorporates c.alternateEffects.generator, so remove it from there.
    c.alternateEffects.generator = emptyEffects.generator;
    if (ae.result instanceof CompletionType) {
      // Erase completions of type CompletionType and prepare for transformation of c to a possibly normal completion
      if (c.alternate instanceof CompletionType) {
        c.updateAlternateKeepingCurrentEffects(new SimpleNormalCompletion(realm.intrinsics.empty, undefined));
      } else if (c.alternate instanceof ForkedAbruptCompletion && c.alternate.containsCompletion(NormalCompletion)) {
        c.updateAlternateKeepingCurrentEffects((c.alternate.transferChildrenToPossiblyNormalCompletion(): any));
      }
    } else {
      ae.result = new CompletionType(realm.intrinsics.empty);
    }

    let e = this.joinForkOrChoose(realm, c.joinCondition, ce, ae);
    if (e.result instanceof ForkedAbruptCompletion) {
      if (e.result.consequent instanceof CompletionType && e.result.alternate instanceof CompletionType) {
        let result = this.collapseResults(realm, e.result.joinCondition, e, e.result.consequent, e.result.alternate);
        e = result.effects;
        invariant(e !== undefined);
      }
    }
    return e;
  }

  joinForkOrChoose(realm: Realm, joinCondition: Value, e1: Effects, e2: Effects): Effects {
    if (!joinCondition.mightNotBeTrue()) return e1;
    if (!joinCondition.mightNotBeFalse()) return e2;
    invariant(joinCondition instanceof AbstractValue);

    let {
      result: result1,
      generator: generator1,
      modifiedBindings: modifiedBindings1,
      modifiedProperties: modifiedProperties1,
      createdObjects: createdObjects1,
    } = e1;
    invariant(result1.effects === e1);

    let {
      result: result2,
      generator: generator2,
      modifiedBindings: modifiedBindings2,
      modifiedProperties: modifiedProperties2,
      createdObjects: createdObjects2,
    } = e2;
    invariant(result2.effects === e2);

    let emptyEffects = construct_empty_effects(realm);

    let result = this.joinOrForkResults(realm, joinCondition, result1, result2, e1, e2);
    if (result1 instanceof AbruptCompletion) {
      if (!(result2 instanceof AbruptCompletion)) {
        invariant(result instanceof PossiblyNormalCompletion);
        e2.generator = emptyEffects.generator;
        return new Effects(result, generator2, modifiedBindings2, modifiedProperties2, createdObjects2);
      }
    } else if (result2 instanceof AbruptCompletion) {
      invariant(result instanceof PossiblyNormalCompletion);
      e1.generator = emptyEffects.generator;
      return new Effects(result, generator1, modifiedBindings1, modifiedProperties1, createdObjects1);
    }

    let [modifiedGenerator1, modifiedGenerator2, bindings] = this.joinBindings(
      realm,
      joinCondition,
      generator1,
      modifiedBindings1,
      generator2,
      modifiedBindings2
    );
    let properties = this.joinPropertyBindings(
      realm,
      joinCondition,
      modifiedProperties1,
      modifiedProperties2,
      createdObjects1,
      createdObjects2
    );
    let createdObjects = new Set();
    createdObjects1.forEach(o => {
      createdObjects.add(o);
    });
    createdObjects2.forEach(o => {
      createdObjects.add(o);
    });

    let generator = joinGenerators(realm, joinCondition, modifiedGenerator1, modifiedGenerator2);

    return new Effects(result, generator, bindings, properties, createdObjects);
  }

  joinNestedEffects(realm: Realm, c: Completion, precedingEffects?: Effects): Effects {
    if (c instanceof PossiblyNormalCompletion || c instanceof ForkedAbruptCompletion) {
      let e1 = this.joinNestedEffects(realm, c.consequent, c.consequentEffects);
      let e2 = this.joinNestedEffects(realm, c.alternate, c.alternateEffects);
      let e3 = this.joinForkOrChoose(realm, c.joinCondition, e1, e2);
      let r = this.collapseResults(realm, c.joinCondition, e3, e1.result, e2.result);
      let re = r.effects;
      invariant(re !== undefined);
      return re;
    }
    if (precedingEffects !== undefined) return precedingEffects;
    let result = construct_empty_effects(realm);
    result.result = c;
    return result;
  }

  collapseResults(
    realm: Realm,
    joinCondition: AbstractValue,
    precedingEffects: Effects,
    result1: EvaluationResult,
    result2: EvaluationResult
  ): Completion {
    let getAbstractValue = (v1: void | Value, v2: void | Value): Value => {
      if (v1 instanceof EmptyValue) return v2 || realm.intrinsics.undefined;
      if (v2 instanceof EmptyValue) return v1 || realm.intrinsics.undefined;
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    if (result1 instanceof BreakCompletion && result2 instanceof BreakCompletion && result1.target === result2.target) {
      let val = this.joinValues(realm, result1.value, result2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new BreakCompletion(val, precedingEffects, joinCondition.expressionLocation, result1.target);
    }
    if (
      result1 instanceof ContinueCompletion &&
      result2 instanceof ContinueCompletion &&
      result1.target === result2.target
    ) {
      return new ContinueCompletion(
        realm.intrinsics.empty,
        precedingEffects,
        joinCondition.expressionLocation,
        result1.target
      );
    }
    if (result1 instanceof ReturnCompletion && result2 instanceof ReturnCompletion) {
      let val = this.joinValues(realm, result1.value, result2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new ReturnCompletion(val, precedingEffects, joinCondition.expressionLocation);
    }
    if (result1 instanceof ThrowCompletion && result2 instanceof ThrowCompletion) {
      getAbstractValue = (v1: void | Value, v2: void | Value) => {
        return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
      };
      let val = this.joinValues(realm, result1.value, result2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new ThrowCompletion(val, precedingEffects, result1.location);
    }
    if (result1 instanceof SimpleNormalCompletion && result2 instanceof SimpleNormalCompletion) {
      return new SimpleNormalCompletion(getAbstractValue(result1.value, result2.value), precedingEffects);
    }
    AbstractValue.reportIntrospectionError(joinCondition);
    throw new FatalError();
  }

  joinOrForkResults(
    realm: Realm,
    joinCondition: AbstractValue,
    result1: EvaluationResult,
    result2: EvaluationResult,
    e1: Effects,
    e2: Effects
  ): Completion {
    invariant(result1.effects === e1);
    invariant(e1.result === result1);
    invariant(result2.effects === e2);
    invariant(e2.result === result2);
    let getAbstractValue = (v1: void | Value, v2: void | Value) => {
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    if (result1 instanceof Reference || result2 instanceof Reference) {
      AbstractValue.reportIntrospectionError(joinCondition);
      throw new FatalError();
    }
    if (result1 instanceof SimpleNormalCompletion && result2 instanceof SimpleNormalCompletion) {
      let val = this.joinValues(realm, result1.value, result2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new SimpleNormalCompletion(val);
    }
    if (result1 instanceof AbruptCompletion && result2 instanceof AbruptCompletion) {
      return new ForkedAbruptCompletion(realm, joinCondition, result1, result2);
    }
    if (result1 instanceof NormalCompletion && result2 instanceof NormalCompletion) {
      return this.joinNormalCompletions(realm, joinCondition, result1, e1, result2, e2);
    }
    if (result1 instanceof AbruptCompletion) {
      let completion = result2;
      let savedEffects;
      let savedPathConditions = [];
      if (result2 instanceof PossiblyNormalCompletion) {
        completion = result2.getNormalCompletion();
        savedEffects = result2.savedEffects;
        savedPathConditions = result2.savedPathConditions;
      }
      invariant(completion instanceof SimpleNormalCompletion);
      return new PossiblyNormalCompletion(
        completion.value,
        joinCondition,
        result1,
        result2,
        savedPathConditions,
        savedEffects
      );
    }
    if (result2 instanceof AbruptCompletion) {
      let completion = result1;
      let savedEffects;
      let savedPathConditions = [];
      if (result1 instanceof PossiblyNormalCompletion) {
        completion = result1.getNormalCompletion();
        savedEffects = result1.savedEffects;
        savedPathConditions = result1.savedPathConditions;
      }
      invariant(completion instanceof SimpleNormalCompletion);
      return new PossiblyNormalCompletion(
        completion.value,
        joinCondition,
        result1,
        result2,
        savedPathConditions,
        savedEffects
      );
    }
    invariant(false);
  }

  composeGenerators(realm: Realm, generator1: Generator, generator2: Generator): Generator {
    // TODO #2222: The path condition of the resulting generator should really just be generator2.pathConditions,
    // and we shouldn't have to bring in generator1.pathConditions. We have observed that this causes an issue
    // in InstantRender.
    let result = new Generator(realm, "composed", generator1.pathConditions.concat(generator2.pathConditions));
    // We copy the entries here because actually composing the generators breaks the serializer
    if (!generator1.empty()) result.appendGenerator(generator1, "");
    if (!generator2.empty()) result.appendGenerator(generator2, "");
    return result;
  }

  // Creates a single map that joins together maps m1 and m2 using the given join
  // operator. If an entry is present in one map but not the other, the missing
  // entry is treated as if it were there and its value were undefined.
  joinMaps<K, V>(m1: Map<K, V>, m2: Map<K, V>, join: (K, void | V, void | V) => V): Map<K, V> {
    let m3: Map<K, V> = new Map();
    m1.forEach((val1, key, map1) => {
      let val2 = m2.get(key);
      let val3 = join(key, val1, val2);
      m3.set(key, val3);
    });
    m2.forEach((val2, key, map2) => {
      if (!m1.has(key)) {
        m3.set(key, join(key, undefined, val2));
      }
    });
    return m3;
  }

  // Creates a single map that has an key, value pair for the union of the key
  // sets of m1 and m2. The value of a pair is the join of m1[key] and m2[key]
  // where the join is defined to be just m1[key] if m1[key] === m2[key] and
  // and abstract value with expression "joinCondition ? m1[key] : m2[key]" if not.
  joinBindings(
    realm: Realm,
    joinCondition: AbstractValue,
    g1: Generator,
    m1: Bindings,
    g2: Generator,
    m2: Bindings
  ): [Generator, Generator, Bindings] {
    let getAbstractValue = (v1: void | Value, v2: void | Value) => {
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    let rewritten1 = false;
    let rewritten2 = false;
    let leak = (b: Binding, g: Generator, v: void | Value, rewritten: boolean) => {
      // just like to what happens in havocBinding, we are going to append a
      // binding-assignment generator entry; however, we play it safe and don't
      // mutate the generator; instead, we create a new one that wraps around the old one.
      if (!rewritten) {
        let h = new Generator(realm, "RewrittenToAppendBindingAssignments", g.pathConditions);
        if (!g.empty()) h.appendGenerator(g, "");
        g = h;
        rewritten = true;
      }
      if (v !== undefined && v !== realm.intrinsics.undefined) g.emitBindingAssignment(b, v);
      return [g, rewritten];
    };
    let join = (b: Binding, b1: void | BindingEntry, b2: void | BindingEntry) => {
      let l1 = b1 === undefined ? b.hasLeaked : b1.hasLeaked;
      let l2 = b2 === undefined ? b.hasLeaked : b2.hasLeaked;
      let v1 = b1 === undefined ? b.value : b1.value;
      let v2 = b2 === undefined ? b.value : b2.value;
      // ensure that if either none or both sides have leaked
      // note that if one side didn't have a binding entry yet, then there's nothing to actively leak
      if (!l1 && l2) [g1, rewritten1] = leak(b, g1, v1, rewritten1);
      else if (l1 && !l2) [g2, rewritten2] = leak(b, g2, v2, rewritten2);
      let hasLeaked = l1 || l2;
      // For leaked (and mutable) bindings, the actual value is no longer directly available.
      // In that case, we reset the value to undefined to prevent any use of the last known value.
      let value = hasLeaked ? undefined : this.joinValues(realm, v1, v2, getAbstractValue);
      invariant(value === undefined || value instanceof Value);
      let previousHasLeaked, previousValue;
      if (b1 !== undefined) {
        previousHasLeaked = b1.previousHasLeaked;
        previousValue = b1.previousValue;
        invariant(
          b2 === undefined || (previousHasLeaked === b2.previousHasLeaked && previousValue === b2.previousValue)
        );
      } else if (b2 !== undefined) {
        previousHasLeaked = b2.previousHasLeaked;
        previousValue = b2.previousValue;
      }
      return { hasLeaked, value, previousHasLeaked, previousValue };
    };
    let joinedBindings = this.joinMaps(m1, m2, join);
    return [g1, g2, joinedBindings];
  }

  // If v1 is known and defined and v1 === v2 return v1,
  // otherwise return getAbstractValue(v1, v2)
  joinValues(
    realm: Realm,
    v1: void | Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    v2: void | Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    getAbstractValue: (void | Value, void | Value) => Value
  ): Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }> {
    if (Array.isArray(v1) || Array.isArray(v2)) {
      invariant(v1 === undefined || Array.isArray(v1));
      invariant(v2 === undefined || Array.isArray(v2));
      return joinArrays(realm, ((v1: any): void | Array<Value>), ((v2: any): void | Array<Value>), getAbstractValue);
    }
    invariant(v1 === undefined || v1 instanceof Value);
    invariant(v2 === undefined || v2 instanceof Value);
    if (
      v1 !== undefined &&
      v2 !== undefined &&
      !(v1 instanceof AbstractValue) &&
      !(v2 instanceof AbstractValue) &&
      StrictEqualityComparison(realm, v1.throwIfNotConcrete(), v2.throwIfNotConcrete())
    ) {
      return v1;
    } else {
      return getAbstractValue(v1, v2);
    }
  }

  joinPropertyBindings(
    realm: Realm,
    joinCondition: AbstractValue,
    m1: PropertyBindings,
    m2: PropertyBindings,
    c1: CreatedObjects,
    c2: CreatedObjects
  ): PropertyBindings {
    let join = (b: PropertyBinding, d1: void | Descriptor, d2: void | Descriptor) => {
      // If the PropertyBinding object has been freshly allocated do not join
      if (d1 === undefined) {
        if (c2.has(b.object)) return d2; // no join
        if (b.descriptor !== undefined && m1.has(b)) {
          // property was deleted
          d1 = cloneDescriptor(b.descriptor);
          invariant(d1 !== undefined);
          d1.value = realm.intrinsics.empty;
        } else {
          // no write to property
          d1 = b.descriptor; //Get value of property before the split
        }
      }
      if (d2 === undefined) {
        if (c1.has(b.object)) return d1; // no join
        if (b.descriptor !== undefined && m2.has(b)) {
          // property was deleted
          d2 = cloneDescriptor(b.descriptor);
          invariant(d2 !== undefined);
          d2.value = realm.intrinsics.empty;
        } else {
          // no write to property
          d2 = b.descriptor; //Get value of property before the split
        }
      }
      return this.joinDescriptors(realm, joinCondition, d1, d2);
    };
    return this.joinMaps(m1, m2, join);
  }

  joinDescriptors(
    realm: Realm,
    joinCondition: AbstractValue,
    d1: void | Descriptor,
    d2: void | Descriptor
  ): void | Descriptor {
    let getAbstractValue = (v1: void | Value, v2: void | Value) => {
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    let clone_with_abstract_value = (d: Descriptor) => {
      invariant(d === d1 || d === d2);
      if (!IsDataDescriptor(realm, d)) {
        let d3: Descriptor = {};
        d3.joinCondition = joinCondition;
        return d3;
      }
      let dc = cloneDescriptor(d);
      invariant(dc !== undefined);
      let dcValue = dc.value;
      if (Array.isArray(dcValue)) {
        invariant(dcValue.length > 0);
        let elem0 = dcValue[0];
        if (elem0 instanceof Value) {
          dc.value = dcValue.map(e => {
            return d === d1
              ? getAbstractValue((e: any), realm.intrinsics.empty)
              : getAbstractValue(realm.intrinsics.empty, (e: any));
          });
        } else {
          dc.value = dcValue.map(e => {
            let { $Key: key1, $Value: val1 } = (e: any);
            let key3 =
              d === d1
                ? getAbstractValue(key1, realm.intrinsics.empty)
                : getAbstractValue(realm.intrinsics.empty, key1);
            let val3 =
              d === d1
                ? getAbstractValue(val1, realm.intrinsics.empty)
                : getAbstractValue(realm.intrinsics.empty, val1);
            return { $Key: key3, $Value: val3 };
          });
        }
      } else {
        invariant(dcValue === undefined || dcValue instanceof Value);
        dc.value =
          d === d1
            ? getAbstractValue(dcValue, realm.intrinsics.empty)
            : getAbstractValue(realm.intrinsics.empty, dcValue);
      }
      return dc;
    };
    if (d1 === undefined) {
      if (d2 === undefined) return undefined;
      // d2 is a new property created in only one branch, join with empty
      let d3 = clone_with_abstract_value(d2);
      if (!IsDataDescriptor(realm, d2)) d3.descriptor2 = d2;
      return d3;
    } else if (d2 === undefined) {
      invariant(d1 !== undefined);
      // d1 is a new property created in only one branch, join with empty
      let d3 = clone_with_abstract_value(d1);
      if (!IsDataDescriptor(realm, d1)) d3.descriptor1 = d1;
      return d3;
    } else {
      if (equalDescriptors(d1, d2) && IsDataDescriptor(realm, d1)) {
        let dc = cloneDescriptor(d1);
        invariant(dc !== undefined);
        dc.value = this.joinValues(realm, d1.value, d2.value, getAbstractValue);
        return dc;
      }
      let d3: Descriptor = {};
      d3.joinCondition = joinCondition;
      d3.descriptor1 = d1;
      d3.descriptor2 = d2;
      return d3;
    }
  }

  mapAndJoin(
    realm: Realm,
    values: Set<ConcreteValue>,
    joinConditionFactory: ConcreteValue => Value,
    functionToMap: ConcreteValue => Completion | Value
  ): Value {
    invariant(values.size > 1);
    let joinedEffects;
    for (let val of values) {
      let condition = joinConditionFactory(val);
      let effects = realm.evaluateForEffects(
        () => {
          invariant(condition instanceof AbstractValue);
          return Path.withCondition(condition, () => {
            return functionToMap(val);
          });
        },
        undefined,
        "mapAndJoin"
      );
      joinedEffects =
        joinedEffects === undefined ? effects : this.joinForkOrChoose(realm, condition, effects, joinedEffects);
    }
    invariant(joinedEffects !== undefined);
    let completion = joinedEffects.result;
    if (completion instanceof PossiblyNormalCompletion) {
      // in this case one of the branches may complete abruptly, which means that
      // not all control flow branches join into one flow at this point.
      // Consequently we have to continue tracking changes until the point where
      // all the branches come together into one.
      completion = realm.composeWithSavedCompletion(completion);
    }
    // Note that the effects of (non joining) abrupt branches are not included
    // in joinedEffects, but are tracked separately inside completion.
    realm.applyEffects(joinedEffects);

    // return or throw completion
    if (completion instanceof AbruptCompletion) throw completion;
    if (completion instanceof SimpleNormalCompletion) {
      completion = completion.value;
    }
    invariant(completion instanceof Value);
    return completion;
  }
}
