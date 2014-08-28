'use strict';

var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var ObjectId = Schema.Types.ObjectId;

var groupSchema = new Schema({
  name: { type: String },
  rating: { tpye: Number, default: 0 },
  updated: { type: Date, default: Date.now },
  _scriptIds: [{ type: ObjectId, ref: 'Script' }],
  size: { type: Number, default: 0 }
});

var Group = mongoose.model('Group', groupSchema);

exports.Group = Group;
