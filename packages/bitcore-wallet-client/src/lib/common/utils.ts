'use strict';

import {
  BitcoreLib,
  BitcoreLibCash,
  BitcoreLibDoge,
  BitcoreLibLtc,
  Deriver,
  Transactions
} from 'crypto-wallet-core';

import * as _ from 'lodash';
import { Constants } from './constants';
import { Defaults } from './defaults';

const $ = require('preconditions').singleton();
const sjcl = require('sjcl');
const Stringify = require('json-stable-stringify');

const Bitcore = BitcoreLib;
const Bitcore_ = {
  btc: Bitcore,
  bch: BitcoreLibCash,
  eth: Bitcore,
  matic: Bitcore,
  xrp: Bitcore,
  doge: BitcoreLibDoge,
  ltc: BitcoreLibLtc
};
const PrivateKey = Bitcore.PrivateKey;
const PublicKey = Bitcore.PublicKey;
const crypto = Bitcore.crypto;

let SJCL = {};

const MAX_DECIMAL_ANY_CHAIN = 18; // more that 14 gives rounding errors

export class Utils {
  // only used for backwards compatibility
  static getChain(coin: string): string {
    try {
      // TODO add a warning that we are not including chain
      let normalizedChain = coin.toLowerCase();
      if (Constants.BITPAY_SUPPORTED_MATIC_ERC20.includes(normalizedChain)) {
        normalizedChain = 'matic';
      } else if (
        Constants.BITPAY_SUPPORTED_ETH_ERC20.includes(normalizedChain) ||
        !Constants.CHAINS.includes(normalizedChain)
      ) {
        // default to eth if it's an ETH ERC20 or if we don't know the chain
        normalizedChain = 'eth';
      }
      return normalizedChain;
    } catch (_) {
      return 'btc'; // coin should always exist but most unit test don't have it -> return btc as default
    }
  }

  static encryptMessage(message, encryptingKey) {
    var key = sjcl.codec.base64.toBits(encryptingKey);
    return sjcl.encrypt(
      key,
      message,
      _.defaults(
        {
          ks: 128,
          iter: 1
        },
        SJCL
      )
    );
  }

  // Will throw if it can't decrypt
  static decryptMessage(cyphertextJson, encryptingKey) {
    if (!cyphertextJson) return;

    if (!encryptingKey) throw new Error('No key');

    var key = sjcl.codec.base64.toBits(encryptingKey);
    return sjcl.decrypt(key, cyphertextJson);
  }

  static decryptMessageNoThrow(cyphertextJson, encryptingKey) {
    if (!encryptingKey) return '<ECANNOTDECRYPT>';

    if (!cyphertextJson) return '';

    // no sjcl encrypted json
    var r = this.isJsonString(cyphertextJson);
    if (!r || !r.iv || !r.ct) {
      return cyphertextJson;
    }

    try {
      return this.decryptMessage(cyphertextJson, encryptingKey);
    } catch (e) {
      return '<ECANNOTDECRYPT>';
    }
  }

  static isJsonString(str) {
    var r;
    try {
      r = JSON.parse(str);
    } catch (e) {
      return false;
    }
    return r;
  }
  /* TODO: It would be nice to be compatible with bitcoind signmessage. How
   * the hash is calculated there? */
  static hashMessage(text) {
    $.checkArgument(text);
    var buf = Buffer.from(text);
    var ret = crypto.Hash.sha256sha256(buf);
    ret = new Bitcore.encoding.BufferReader(ret).readReverse();
    return ret;
  }

  static signMessage(message, privKey) {
    $.checkArgument(message);
    var priv = new PrivateKey(privKey);
    const flattenedMessage = _.isArray(message) ? _.join(message) : message;
    var hash = this.hashMessage(flattenedMessage);
    return crypto.ECDSA.sign(hash, priv, 'little').toString();
  }

  static verifyMessage(message: Array<string> | string, signature, pubKey) {
    $.checkArgument(message);
    $.checkArgument(pubKey);

    if (!signature) return false;

    var pub = new PublicKey(pubKey);
    const flattenedMessage = _.isArray(message) ? _.join(message) : message;
    const hash = this.hashMessage(flattenedMessage);
    try {
      var sig = new crypto.Signature.fromString(signature);
      return crypto.ECDSA.verify(hash, sig, pub, 'little');
    } catch (e) {
      return false;
    }
  }

  static privateKeyToAESKey(privKey) {
    $.checkArgument(privKey && _.isString(privKey));
    $.checkArgument(
      Bitcore.PrivateKey.isValid(privKey),
      'The private key received is invalid'
    );
    var pk = Bitcore.PrivateKey.fromString(privKey);
    return Bitcore.crypto.Hash.sha256(pk.toBuffer())
      .slice(0, 16)
      .toString('base64');
  }

  static getCopayerHash(name, xPubKey, requestPubKey) {
    return [name, xPubKey, requestPubKey].join('|');
  }

  static getProposalHash(proposalHeader) {
    // For backwards compatibility
    if (arguments.length > 1) {
      return this.getOldHash.apply(this, arguments);
    }

    return Stringify(proposalHeader);
  }

  static getOldHash(toAddress, amount, message, payProUrl) {
    return [toAddress, amount, message || '', payProUrl || ''].join('|');
  }

  static parseDerivationPath(path: string) {
    const pathIndex = /m\/([0-9]*)\/([0-9]*)/;
    const [_input, changeIndex, addressIndex] = path.match(pathIndex);
    const isChange = Number.parseInt(changeIndex) > 0;
    return { _input, addressIndex, isChange };
  }

  static deriveAddress(
    scriptType,
    publicKeyRing,
    path,
    m,
    network,
    chain,
    escrowInputs?
  ) {
    $.checkArgument(_.includes(_.values(Constants.SCRIPT_TYPES), scriptType));

    chain = chain || 'btc';
    var bitcore = Bitcore_[chain];
    var publicKeys = _.map(publicKeyRing, item => {
      var xpub = new bitcore.HDPublicKey(item.xPubKey);
      return xpub.deriveChild(path).publicKey;
    });

    var bitcoreAddress;
    switch (scriptType) {
      case Constants.SCRIPT_TYPES.P2WSH:
        const nestedWitness = false;
        bitcoreAddress = bitcore.Address.createMultisig(
          publicKeys,
          m,
          network,
          nestedWitness,
          'witnessscripthash'
        );
        break;
      case Constants.SCRIPT_TYPES.P2SH:
        if (escrowInputs) {
          var xpub = new bitcore.HDPublicKey(publicKeyRing[0].xPubKey);
          const inputPublicKeys = escrowInputs.map(
            input => xpub.deriveChild(input.path).publicKey
          );
          bitcoreAddress = bitcore.Address.createEscrow(
            inputPublicKeys,
            publicKeys[0],
            network
          );
          publicKeys = [publicKeys[0], ...inputPublicKeys];
        } else {
          bitcoreAddress = bitcore.Address.createMultisig(
            publicKeys,
            m,
            network
          );
        }
        break;
      case Constants.SCRIPT_TYPES.P2WPKH:
        bitcoreAddress = bitcore.Address.fromPublicKey(
          publicKeys[0],
          network,
          'witnesspubkeyhash'
        );
        break;
      case Constants.SCRIPT_TYPES.P2PKH:
        $.checkState(
          _.isArray(publicKeys) && publicKeys.length == 1,
          'publicKeys array undefined'
        );
        if (Constants.UTXO_CHAINS.includes(chain)) {
          bitcoreAddress = bitcore.Address.fromPublicKey(
            publicKeys[0],
            network
          );
        } else {
          const { addressIndex, isChange } = this.parseDerivationPath(path);
          const [{ xPubKey }] = publicKeyRing;
          bitcoreAddress = Deriver.deriveAddress(
            chain.toUpperCase(),
            network,
            xPubKey,
            addressIndex,
            isChange
          );
        }
        break;
    }

    return {
      address: bitcoreAddress.toString(true),
      path,
      publicKeys: _.invokeMap(publicKeys, 'toString')
    };
  }

  // note that we use the string version of xpub,
  // serialized by BITCORE BTC.
  // testnet xpub starts with t.
  // livenet xpub starts with x.
  // no matter WHICH chain
  static xPubToCopayerId(_chain, xpub) {
    // this was introduced because we allowed coinType = 0' wallets for BCH
    // for the  "wallet duplication" feature
    // now it is effective for all coins.

    const chain = _chain.toLowerCase();
    var str = chain == 'btc' ? xpub : chain + xpub;

    var hash = sjcl.hash.sha256.hash(str);
    return sjcl.codec.hex.fromBits(hash);
  }

  static signRequestPubKey(requestPubKey, xPrivKey) {
    var priv = new Bitcore.HDPrivateKey(xPrivKey).deriveChild(
      Constants.PATHS.REQUEST_KEY_AUTH
    ).privateKey;
    return this.signMessage(requestPubKey, priv);
  }

  static verifyRequestPubKey(requestPubKey, signature, xPubKey) {
    var pub = new Bitcore.HDPublicKey(xPubKey).deriveChild(
      Constants.PATHS.REQUEST_KEY_AUTH
    ).publicKey;
    return this.verifyMessage(requestPubKey, signature, pub.toString());
  }

  static formatAmount(satoshis, unit, opts?) {
    $.shouldBeNumber(satoshis);

    var clipDecimals = (number, decimals) => {
      let str = number.toString();
      if (str.indexOf('e') >= 0) {
        // fixes eth small balances
        str = number.toFixed(MAX_DECIMAL_ANY_CHAIN);
      }
      var x = str.split('.');

      var d = (x[1] || '0').substring(0, decimals);
      const ret = parseFloat(x[0] + '.' + d);
      return ret;
    };

    var addSeparators = (nStr, thousands, decimal, minDecimals) => {
      nStr = nStr.replace('.', decimal);
      var x = nStr.split(decimal);
      var x0 = x[0];
      var x1 = x[1];

      x1 = _.dropRightWhile(x1, (n, i) => {
        return n == '0' && i >= minDecimals;
      }).join('');
      var x2 = x.length > 1 ? decimal + x1 : '';

      x0 = x0.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return x0 + x2;
    };

    opts = opts || {};

    var u = Constants.UNITS[unit];
    var precision = opts.fullPrecision ? 'full' : 'short';
    var decimals = opts.decimals ? opts.decimals[precision] : u[precision];
    var toSatoshis = opts.toSatoshis ? opts.toSatoshis : u.toSatoshis;
    var amount = clipDecimals(
      satoshis / toSatoshis,
      decimals.maxDecimals
    ).toFixed(decimals.maxDecimals);
    return addSeparators(
      amount,
      opts.thousandsSeparator || ',',
      opts.decimalSeparator || '.',
      decimals.minDecimals
    );
  }

  static buildTx(txp) {
    var chain = txp.chain?.toLowerCase() || Utils.getChain(txp.coin); // getChain -> backwards compatibility

    if (Constants.UTXO_CHAINS.includes(chain)) {
      var bitcore = Bitcore_[chain];

      var t = new bitcore.Transaction();

      if (txp.version >= 4) {
        t.setVersion(2);
      } else {
        t.setVersion(1);
      }

      $.checkState(
        _.includes(_.values(Constants.SCRIPT_TYPES), txp.addressType),
        'Failed state: addressType not in SCRIPT_TYPES'
      );

      switch (txp.addressType) {
        case Constants.SCRIPT_TYPES.P2WSH:
        case Constants.SCRIPT_TYPES.P2SH:
          _.each(txp.inputs, i => {
            t.from(i, i.publicKeys, txp.requiredSignatures);
          });
          break;
        case Constants.SCRIPT_TYPES.P2WPKH:
        case Constants.SCRIPT_TYPES.P2PKH:
          t.from(txp.inputs);
          break;
      }

      if (txp.toAddress && txp.amount && !txp.outputs) {
        t.to(txp.toAddress, txp.amount);
      } else if (txp.outputs) {
        _.each(txp.outputs, o => {
          $.checkState(
            o.script || o.toAddress,
            'Output should have either toAddress or script specified'
          );
          if (o.script) {
            t.addOutput(
              new bitcore.Transaction.Output({
                script: o.script,
                satoshis: o.amount
              })
            );
          } else {
            t.to(o.toAddress, o.amount);
          }
        });
      }

      t.fee(txp.fee);

      if (txp.instantAcceptanceEscrow && txp.escrowAddress) {
        t.escrow(
          txp.escrowAddress.address,
          txp.instantAcceptanceEscrow + txp.fee
        );
      }

      t.change(txp.changeAddress.address);

      if (txp.enableRBF) t.enableRBF();

      // Shuffle outputs for improved privacy
      if (t.outputs.length > 1) {
        var outputOrder = _.reject(txp.outputOrder, order => {
          return order >= t.outputs.length;
        });
        $.checkState(
          t.outputs.length == outputOrder.length,
          'Failed state: t.ouputs.length == outputOrder.length at buildTx()'
        );
        t.sortOutputs(outputs => {
          return _.map(outputOrder, i => {
            return outputs[i];
          });
        });
      }

      // Validate inputs vs outputs independently of Bitcore
      var totalInputs = _.reduce(
        txp.inputs,
        (memo, i) => {
          return +i.satoshis + memo;
        },
        0
      );
      var totalOutputs = _.reduce(
        t.outputs,
        (memo, o) => {
          return +o.satoshis + memo;
        },
        0
      );

      $.checkState(
        totalInputs - totalOutputs >= 0,
        'Failed state: totalInputs - totalOutputs >= 0 at buildTx'
      );
      $.checkState(
        totalInputs - totalOutputs <= Defaults.MAX_TX_FEE(chain),
        'Failed state: totalInputs - totalOutputs <= Defaults.MAX_TX_FEE(chain) at buildTx'
      );

      return t;
    } else {
      // ETH ERC20 XRP
      const {
        data,
        destinationTag,
        outputs,
        payProUrl,
        tokenAddress,
        multisigContractAddress,
        isTokenSwap
      } = txp;
      const recipients = outputs.map(output => {
        return {
          amount: output.amount,
          address: output.toAddress,
          data: output.data,
          gasLimit: output.gasLimit
        };
      });
      // Backwards compatibility BWC <= 8.9.0
      if (data) {
        recipients[0].data = data;
      }
      const unsignedTxs = [];
      // If it is a token swap its an already created ERC20 transaction so we skip it and go directly to ETH transaction create
      const isERC20 = tokenAddress && !payProUrl && !isTokenSwap;
      const isMULTISIG = multisigContractAddress;
      const chainName = chain.toUpperCase();
      const _chain = isMULTISIG
        ? chainName + 'MULTISIG'
        : isERC20
        ? chainName + 'ERC20'
        : chainName;
      for (let index = 0; index < recipients.length; index++) {
        const rawTx = Transactions.create({
          ...txp,
          ...recipients[index],
          tag: destinationTag ? Number(destinationTag) : undefined,
          chain: _chain,
          nonce: Number(txp.nonce) + Number(index),
          recipients: [recipients[index]]
        });
        unsignedTxs.push(rawTx);
      }
      return { uncheckedSerialize: () => unsignedTxs };
    }
  }
}
