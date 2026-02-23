(function () {
  'use strict';

  var form = document.getElementById('form-reservation');
  var inputArrivee = document.getElementById('date-arrivee');
  var inputDepart = document.getElementById('date-depart');
  var btnSubmit = document.getElementById('btn-submit');
  var recapBlock = document.getElementById('recap-prix');
  var fpArrivee, fpDepart;

  var API_BASE = '';

  function getBookedDates(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API_BASE + '/api/booked-dates', true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          callback(data.dates || []);
        } catch (e) {
          callback([]);
        }
      } else {
        callback([]);
      }
    };
    xhr.onerror = function () { callback([]); };
    xhr.send();
  }

  function disableDatesForFlatpickr(dates) {
    if (!dates || !dates.length) return [];
    return dates.map(function (d) { return d; });
  }

  function initCalendars(disabledDates) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var disableRule = disabledDates && disabledDates.length
      ? disabledDates
      : [];

    fpArrivee = flatpickr(inputArrivee, {
      locale: 'fr',
      dateFormat: 'd/m/Y',
      altInput: false,
      minDate: today,
      allowInput: false,
      disableMobile: true,
      disable: disableRule,
      onChange: function (selectedDates) {
        if (selectedDates[0] && fpDepart) {
          fpDepart.set('minDate', selectedDates[0]);
          if (fpDepart.selectedDates[0] && fpDepart.selectedDates[0] < selectedDates[0]) {
            fpDepart.setDate(selectedDates[0], false);
          }
        }
        updateRecap();
      }
    });

    fpDepart = flatpickr(inputDepart, {
      locale: 'fr',
      dateFormat: 'd/m/Y',
      minDate: today,
      allowInput: false,
      disableMobile: true,
      disable: disableRule,
      onChange: function () { updateRecap(); }
    });
  }

  function getNightPrice(date) {
    // 0 = dimanche, 1 = lundi, ..., 6 = samedi
    var day = date.getDay();
    // Vendredi (5) et samedi (6) = week-end
    if (day === 5 || day === 6) return 205;
    // Dimanche traité comme semaine par défaut
    return 155;
  }

  function computeBaseAmount(d1, d2) {
    var nights = 0;
    var total = 0;
    var cursor = new Date(d1.getTime());
    cursor.setHours(0, 0, 0, 0);
    var end = new Date(d2.getTime());
    end.setHours(0, 0, 0, 0);
    while (cursor < end) {
      total += getNightPrice(cursor);
      nights += 1;
      cursor.setDate(cursor.getDate() + 1);
    }
    return { nights: nights, base: total };
  }

  var OPTION_LABELS = {
    petales: 'Pétales de roses',
    bouquet: 'Bouquet personnalisé',
    champagne: 'Champagne',
    formule80: 'Formule 80',
    arrivee15: 'Arrivée anticipée (15h)',
    depart14: 'Départ tardif (14h)'
  };

  var OPTION_PRICES = {
    petales: 30,
    bouquet: 50,
    champagne: 50,
    formule80: 80,
    arrivee15: 40,
    depart14: 40
  };

  function getSelectedOptionKeys() {
    if (!form) return [];
    var inputs = form.querySelectorAll('.option-input');
    var keys = [];
    inputs.forEach(function (input) {
      if (input.checked) keys.push(input.value);
    });
    return keys;
  }

  function updateRecap() {
    if (!recapBlock || !fpArrivee || !fpDepart) return;
    var d1 = fpArrivee.selectedDates[0];
    var d2 = fpDepart.selectedDates[0];
    if (!d1 || !d2) {
      recapBlock.style.display = 'none';
      return;
    }

    var baseInfo = computeBaseAmount(d1, d2);
    var nights = baseInfo.nights;
    if (nights <= 0) {
      recapBlock.style.display = 'none';
      return;
    }

    var optionKeys = getSelectedOptionKeys();
    var optionsTotal = optionKeys.reduce(function (sum, key) {
      return sum + (OPTION_PRICES[key] || 0);
    }, 0);

    var totalBeforeDiscount = baseInfo.base + optionsTotal;
    var discount = nights >= 2 ? totalBeforeDiscount * 0.15 : 0;
    var totalFinal = totalBeforeDiscount - discount;

    var datesText = d1.toLocaleDateString('fr-FR') + ' → ' + d2.toLocaleDateString('fr-FR') +
      ' (' + nights + ' nuit' + (nights > 1 ? 's' : '') + ')';
    document.getElementById('recap-dates').textContent = datesText;

    var optionsText;
    if (!optionKeys.length) {
      optionsText = 'Options : aucune option ajoutée';
    } else {
      optionsText = 'Options : ' + optionKeys.map(function (key) {
        var label = OPTION_LABELS[key] || key;
        var price = OPTION_PRICES[key] || 0;
        return label + ' (+' + price + ' €)';
      }).join(', ');
    }
    document.getElementById('recap-pack').textContent = optionsText;

    var totalStr = totalFinal.toFixed(2).replace('.', ',');
    var recapTotal = 'Total : ' + totalStr + ' €';
    if (discount > 0) {
      recapTotal += ' (remise 15 % dès 2 nuits incluse)';
    }
    document.getElementById('recap-total').textContent = recapTotal;
    recapBlock.style.display = 'block';
  }

  if (form) {
    form.addEventListener('change', function () {
      updateRecap();
    });
  }

  if (typeof flatpickr === 'undefined') {
    if (inputArrivee && inputDepart) {
      inputArrivee.type = 'date';
      inputDepart.type = 'date';
      inputArrivee.removeAttribute('readonly');
      inputDepart.removeAttribute('readonly');
      var todayStr = new Date().toISOString().split('T')[0];
      inputArrivee.min = todayStr;
      inputDepart.min = todayStr;
      inputArrivee.addEventListener('change', function () {
        inputDepart.min = inputArrivee.value;
        if (inputDepart.value && inputDepart.value < inputArrivee.value) inputDepart.value = inputArrivee.value;
      });
    }
  } else {
    getBookedDates(function (dates) {
      initCalendars(dates);
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!inputArrivee || !inputDepart) return;
      var d1 = fpArrivee && fpArrivee.selectedDates[0];
      var d2 = fpDepart && fpDepart.selectedDates[0];
      if (!d1 || !d2) {
        alert('Veuillez choisir les dates d\'arrivée et de départ.');
        return;
      }
      var dateArrivee = d1.toISOString().slice(0, 10);
      var dateDepart = d2.toISOString().slice(0, 10);
      var optionKeys = getSelectedOptionKeys();
      var nom = form.nom && form.nom.value ? form.nom.value.trim() : '';
      var email = form.email && form.email.value ? form.email.value.trim() : '';
      if (!nom || !email) {
        alert('Veuillez remplir nom et email.');
        return;
      }

      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Redirection vers le paiement…';
      }

      var payload = {
        date_arrivee: dateArrivee,
        date_depart: dateDepart,
        options: optionKeys,
        nom: nom,
        email: email,
        telephone: (form.telephone && form.telephone.value) ? form.telephone.value.trim() : '',
        message: (form.message && form.message.value) ? form.message.value.trim() : ''
      };

      var xhr = new XMLHttpRequest();
      xhr.open('POST', API_BASE + '/api/create-reservation', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Payer et réserver';
        }
        if (xhr.status === 200) {
          var data;
          try {
            data = JSON.parse(xhr.responseText);
          } catch (err) {
            alert('Erreur de réponse du serveur.');
            return;
          }
          if (data.url) {
            window.location.href = data.url;
            return;
          }
        }
        if (xhr.status === 503) {
          var msg = 'Paiement non configuré côté serveur. Réservez par téléphone ou email en attendant.';
          try {
            var r = JSON.parse(xhr.responseText);
            if (r.message) msg = r.message;
          } catch (e) {}
          alert(msg);
          return;
        }
        var errMsg = 'Impossible de créer la réservation. Réessayez ou contactez-nous.';
        try {
          var r = JSON.parse(xhr.responseText);
          if (r.error) errMsg = r.error;
          if (r.detail) errMsg += '\n\nDétail : ' + r.detail;
        } catch (e) {}
        alert(errMsg);
      };
      xhr.onerror = function () {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Payer et réserver';
        }
        alert('Erreur de connexion. Vérifiez que le serveur tourne (npm start) et réessayez.');
      };
      xhr.send(JSON.stringify(payload));
    });
  }

  // Message succès / annulation
  var params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    if (recapBlock) recapBlock.style.display = 'none';
    var sessionId = params.get('session_id');
    var recapSuccess = document.getElementById('recap-success');
    if (sessionId) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', API_BASE + '/api/confirm-session?session_id=' + encodeURIComponent(sessionId), true);
      xhr.onload = function () {
        window.history.replaceState({}, document.title, window.location.pathname);
        alert('Merci ! Votre réservation est confirmée. Consultez le récapitulatif ci-dessous.');
        if (xhr.status === 200 && recapSuccess) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.booking) {
              var b = data.booking;
              document.getElementById('recap-success-nom').textContent = b.nom || '';
              var d1 = b.date_arrivee ? new Date(b.date_arrivee) : null;
              var d2 = b.date_depart ? new Date(b.date_depart) : null;
              var datesStr = (d1 && d2) ? 'Du ' + d1.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' au ' + d2.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : (b.date_arrivee + ' → ' + b.date_depart);
              document.getElementById('recap-success-dates').textContent = datesStr;
              var optKeys = (b.options || '').split(',').filter(Boolean);
              var optionsStr = optKeys.length ? optKeys.map(function (k) { return OPTION_LABELS[k] || k; }).join(', ') : 'Aucune option';
              document.getElementById('recap-success-options').textContent = 'Options : ' + optionsStr;
              var totalEuros = b.amount_cents ? (b.amount_cents / 100).toFixed(2).replace('.', ',') : '—';
              document.getElementById('recap-success-total').textContent = 'Total payé : ' + totalEuros + ' €';
              recapSuccess.style.display = 'block';
              if (form) form.style.display = 'none';
            }
          } catch (e) {}
        }
      };
      xhr.onerror = function () {
        window.history.replaceState({}, document.title, window.location.pathname);
        alert('Merci ! Votre réservation est confirmée.');
      };
      xhr.send();
    } else {
      window.history.replaceState({}, document.title, window.location.pathname);
      alert('Merci ! Votre réservation est confirmée.');
    }
  }
  if (params.get('cancel') === '1') {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
})();
