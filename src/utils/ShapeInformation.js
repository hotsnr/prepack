/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Utils } from "../singletons.js";
import { Value } from "../values/index.js";
import type { SupportedGraphQLGetters, ShapeInformationInterface } from "../types.js";

type ECMAScriptType =
  | "void"
  | "null"
  | "boolean"
  | "string"
  | "symbol"
  | "number"
  | "object"
  | "array"
  | "function"
  | "integral";

type ShapeDescriptorCommon = {
  jsType: ECMAScriptType,
  graphQLType?: string,
};

type ShapePropertyDescriptor = {
  shape: ShapeDescriptor,
  optional: boolean,
};

type ShapeDescriptorOfObject = ShapeDescriptorCommon & {
  kind: "object",
  properties: { [string]: void | ShapePropertyDescriptor },
};

type ShapeDescriptorOfArray = ShapeDescriptorCommon & {
  kind: "array",
  elementShape: void | ShapePropertyDescriptor,
};

type ShapeDescriptorOfLink = ShapeDescriptorCommon & {
  kind: "link",
  shapeName: string,
};

type ShapeDescriptorOfPrimitive = ShapeDescriptorCommon & {
  kind: "scalar",
};

type ShapeDescriptorOfEnum = ShapeDescriptorCommon & {
  kind: "enum",
};

export type ShapeDescriptorNonLink =
  | ShapeDescriptorOfObject
  | ShapeDescriptorOfArray
  | ShapeDescriptorOfPrimitive
  | ShapeDescriptorOfEnum;

export type ShapeDescriptor = ShapeDescriptorNonLink | ShapeDescriptorOfLink;

export type ShapeUniverse = { [string]: ShapeDescriptor };

export type ArgModel = {
  universe: ShapeUniverse,
  arguments: { [string]: string },
};

export type ComponentModel = {
  universe: ShapeUniverse,
  component: { props: string },
};

export class ShapeInformation implements ShapeInformationInterface {
  constructor(
    descriptor: ShapeDescriptorNonLink,
    parentDescriptor: void | ShapeDescriptorNonLink,
    parentKey: void | string,
    universe: ShapeUniverse
  ) {
    this._descriptor = descriptor;
    this._parentDescriptor = parentDescriptor;
    this._parentKey = parentKey;
    this._universe = universe;
  }

  _descriptor: ShapeDescriptorNonLink;
  _parentDescriptor: void | ShapeDescriptorNonLink;
  _parentKey: void | string;
  _universe: ShapeUniverse;

  getGetter(): void | SupportedGraphQLGetters {
    // we want getter only for existing GraphQL objects
    return this._parentDescriptor !== undefined &&
      this._parentDescriptor.graphQLType !== undefined &&
      this._parentDescriptor.kind === "object"
      ? this._getAssociatedGetter()
      : undefined;
  }

  getAbstractType(): typeof Value {
    // we assume that value is not optional if it root
    if (this._isOptional() || this._descriptor.jsType === "void" || this._descriptor.jsType === "null") {
      return Value;
    }
    return Utils.getTypeFromName(this._descriptor.jsType) || Value;
  }

  getPropertyShape(key: string): void | ShapeInformation {
    let property = this._getInformationForProperty(key);
    return property !== undefined
      ? ShapeInformation._resolveLinksAndWrap(property.shape, this._descriptor, key, this._universe)
      : undefined;
  }

  static createForArgument(model: void | ArgModel, argname: string): void | ShapeInformation {
    return model !== undefined
      ? ShapeInformation._resolveLinksAndWrap(
          model.universe[model.arguments[argname]],
          undefined,
          undefined,
          model.universe
        )
      : undefined;
  }

  static createForReactComponentProps(model: void | ComponentModel): void | ShapeInformation {
    return model !== undefined
      ? ShapeInformation._resolveLinksAndWrap(
          model.universe[model.component.props],
          undefined,
          undefined,
          model.universe
        )
      : undefined;
  }

  _isOptional(): void | boolean {
    if (this._parentDescriptor === undefined) {
      return undefined;
    }
    switch (this._parentDescriptor.kind) {
      case "object":
        return this._parentKey !== undefined && this._parentDescriptor.properties[this._parentKey] !== undefined
          ? this._parentDescriptor.properties[this._parentKey].optional
          : undefined;
      case "array":
        return this._parentDescriptor.elementShape !== undefined
          ? this._parentDescriptor.elementShape.optional
          : undefined;
      default:
        return undefined;
    }
  }

  _getInformationForProperty(key: string): void | ShapePropertyDescriptor {
    switch (this._descriptor.kind) {
      case "object":
        return this._descriptor.properties[key];
      case "array":
        switch (key) {
          case "length":
            return ShapeInformation._arrayLengthProperty;
          case "prototype":
            return undefined;
          default:
            return this._descriptor.elementShape;
        }
      default:
        // it is still legal to do member access on primitive value
        // such as string
        return undefined;
    }
  }

  _getAssociatedGetter(): void | SupportedGraphQLGetters {
    switch (this._descriptor.kind) {
      case "object":
        return "tree";
      case "array":
        let elementShape =
          this._descriptor.elementShape !== undefined ? this._descriptor.elementShape.shape : undefined;
        let innerShape = ShapeInformation._resolveLinksAndWrap(
          elementShape,
          this._descriptor,
          undefined,
          this._universe
        );
        if (innerShape === undefined) {
          return undefined;
        }
        switch (innerShape._getAssociatedGetter()) {
          case "bool":
            return "bool_list";
          case "double":
            return "double_list";
          case "int":
            return "int_list";
          case "time":
            return "time_list";
          case "string":
            return "string_list";
          case "tree":
            return "tree_list";
          // no support for nested arrays yet
          default:
            return undefined;
        }
      case "scalar":
        switch (this._descriptor.graphQLType) {
          case "Color":
          case "File":
          case "ID":
          case "String":
          case "Url":
            return "string";
          case "Int":
          case "Time":
            return "int";
          case "Float":
            return "double";
          case "Boolean":
            return "bool";
          default:
            return undefined;
        }
      case "enum":
        return "string";
      default:
        return undefined;
    }
  }

  static _resolveLinksAndWrap(
    descriptor: void | ShapeDescriptor,
    parentDescription: void | ShapeDescriptorNonLink,
    parentKey: void | string,
    universe: ShapeUniverse
  ): void | ShapeInformation {
    while (descriptor && descriptor.kind === "link") {
      descriptor = universe[descriptor.shapeName];
    }
    return descriptor !== undefined
      ? new ShapeInformation(descriptor, parentDescription, parentKey, universe)
      : undefined;
  }

  static _arrayLengthProperty = {
    shape: {
      kind: "scalar",
      jsType: "integral",
    },
    optional: false,
  };
}
