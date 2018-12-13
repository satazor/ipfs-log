'use strict';

var IPFSNotDefinedError = function IPFSNotDefinedError() {
  return new Error('IPFS instance not defined');
};
var LogNotDefinedError = function LogNotDefinedError() {
  return new Error('Log instance not defined');
};
var NotALogError = function NotALogError() {
  return new Error('Given argument is not an instance of Log');
};
var CannotJoinWithDifferentId = function CannotJoinWithDifferentId() {
  return new Error('Can\'t join logs with different IDs');
};

module.exports = {
  IPFSNotDefinedError: IPFSNotDefinedError,
  LogNotDefinedError: LogNotDefinedError,
  NotALogError: NotALogError,
  CannotJoinWithDifferentId: CannotJoinWithDifferentId
};